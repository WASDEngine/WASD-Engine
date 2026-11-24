/** Choosing the archive of a download and the map pictures inside it. */
import { describe, expect, it } from 'vitest'
import { archivePictures, checkMaps, chooseArchive, formatOptions, mapKey, selectPictures } from '../src/files.ts'
import type { AmbientCgArchive, AmbientCgAsset } from '../src/types.ts'

function archive(attributes: string, size: number): AmbientCgArchive {
  const [resolution = '', format = 'exr'] = attributes.toLowerCase().split('-')
  return { resolution, format, attributes, url: `https://ambientcg.com/get?file=Bricks097_${attributes}.zip`, size }
}

const BRICKS: AmbientCgAsset = {
  id: 'Bricks097', title: 'Bricks 097', kind: 'material', tags: ['brick', 'wall'], maps: ['color', 'displacement', 'normal', 'roughness', 'ambient-occlusion'],
  technique: 'surface-photogrammetry', downloads: 62_514, released: '2026-10-24', sizeCm: [240, 120],
  archives: [archive('1K-JPG', 1000), archive('2K-JPG', 4000), archive('2K-PNG', 9000)],
}

const SKY: AmbientCgAsset = {
  id: 'EveningSkyHDRI049B', title: 'Evening Sky HDRI 049 B', kind: 'hdri', tags: ['sky'], maps: [], technique: '', downloads: 907, released: '',
  archives: [archive('2K', 5000), archive('4K', 16_000)],
}

function file(name: string, bytes = 10, crc32 = 1) {
  return { name, bytes, crc32 }
}

const BRICK_FILES = [
  file('Bricks097_1K-JPG.usdc'), file('Bricks097_1K-JPG_AmbientOcclusion.jpg'), file('Bricks097_1K-JPG_Color.jpg'), file('Bricks097_1K-JPG_Displacement.jpg'),
  file('Bricks097_1K-JPG_NormalDX.jpg'), file('Bricks097_1K-JPG_NormalGL.jpg'), file('Bricks097_1K-JPG_Roughness.jpg'), file('Bricks097_1K-JPG.blend'),
  file('Bricks097_1K-JPG.tres'), file('Bricks097.png'),
]

describe('chooseArchive', () => {
  it('takes jpg at 1k by default, the smallest resolution where there is no 1k, and what the call names', () => {
    expect(formatOptions(BRICKS)).toEqual([
      { format: 'jpg', resolutions: [{ resolution: '1k', bytes: 1000 }, { resolution: '2k', bytes: 4000 }] },
      { format: 'png', resolutions: [{ resolution: '2k', bytes: 9000 }] },
    ])
    expect(chooseArchive(BRICKS, {}).attributes).toBe('1K-JPG')
    expect(chooseArchive(BRICKS, { format: 'png' }).attributes).toBe('2K-PNG')
    expect(chooseArchive(BRICKS, { resolution: '2k' }).attributes).toBe('2K-JPG')
    expect(chooseArchive(SKY, {}).attributes).toBe('2K')
    expect(chooseArchive(SKY, { resolution: '4k' }).format).toBe('exr')
  })

  it('names what the asset offers when it lacks the format or the resolution', () => {
    expect(() => chooseArchive(BRICKS, { format: 'exr' })).toThrow('Bricks 097 has no exr files; it offers: jpg, png.')
    expect(() => chooseArchive(BRICKS, { resolution: '8k' })).toThrow('Bricks 097 has no 8k in jpg; it offers: 1k, 2k.')
    expect(() => chooseArchive(SKY, { format: 'jpg' })).toThrow('Evening Sky HDRI 049 B has no jpg files; an HDRI is an exr panorama; leave format out.')
    expect(() => chooseArchive({ ...BRICKS, archives: [] }, {})).toThrow('Bricks 097 has no files that ambientcg_download can fetch.')
  })
})

describe('mapKey and checkMaps', () => {
  it('folds the names of one map together, with normal as the OpenGL normal map', () => {
    expect(['normal', 'NormalGL', 'Normal-GL', 'normal_gl'].map(mapKey)).toEqual(['normalgl', 'normalgl', 'normalgl', 'normalgl'])
    expect(['NormalDX', 'ambient-occlusion', 'AO', 'albedo', 'Metallic', 'height', 'alpha'].map(mapKey))
      .toEqual(['normaldx', 'ambientocclusion', 'ambientocclusion', 'color', 'metalness', 'displacement', 'opacity'])
  })

  it('refuses a map the asset does not list before anything is downloaded', () => {
    expect(() => { checkMaps(BRICKS, ['color', 'normal', 'NormalDX', 'AO']) }).not.toThrow()
    expect(() => { checkMaps(BRICKS, ['color', 'opacity']) }).toThrow('Bricks 097 has no "opacity" map; its maps are: color, displacement, normal, roughness, ambient-occlusion.')
    expect(() => { checkMaps(BRICKS, []) }).toThrow('maps names no map; leave it out for every map.')
    expect(() => { checkMaps(SKY, ['hdr', 'tonemapped']) }).not.toThrow()
    expect(() => { checkMaps(SKY, ['color']) }).toThrow('Evening Sky HDRI 049 B has no "color" map; its maps are: HDR, TONEMAPPED.')
    expect(() => { checkMaps({ ...BRICKS, maps: [] }, ['anything']) }).not.toThrow()
  })
})

describe('archivePictures and selectPictures', () => {
  it('finds the map pictures of the asset among an archive\'s files, in the archive\'s order', () => {
    const pictures = archivePictures(BRICKS, [...BRICK_FILES, file('textures/Bricks097_1K-JPG_Color.jpg'), file('Other_1K-JPG_Color.jpg'), file('bricks097_1k-jpg_Emission.PNG', 7, 9)])
    expect(pictures.map(picture => picture.map)).toEqual(['AmbientOcclusion', 'Color', 'Displacement', 'NormalDX', 'NormalGL', 'Roughness', 'Emission'])
    expect(pictures.at(-1)).toEqual({ name: 'bricks097_1k-jpg_Emission.PNG', map: 'Emission', bytes: 7, crc32: 9 })
  })

  it('takes every map but the DirectX normal map by default, an HDRI\'s panorama, and the maps a call names', () => {
    const pictures = archivePictures(BRICKS, BRICK_FILES)
    expect(selectPictures(BRICKS, pictures, undefined).map(picture => picture.map)).toEqual(['AmbientOcclusion', 'Color', 'Displacement', 'NormalGL', 'Roughness'])
    expect(selectPictures(BRICKS, pictures, ['color', 'normal', 'AO']).map(picture => picture.map)).toEqual(['AmbientOcclusion', 'Color', 'NormalGL'])
    expect(selectPictures(BRICKS, pictures, ['NormalDX']).map(picture => picture.name)).toEqual(['Bricks097_1K-JPG_NormalDX.jpg'])
    const sky = archivePictures(SKY, [file('EveningSkyHDRI049B_2K.usdc'), file('EveningSkyHDRI049B_2K_HDR.exr'), file('EveningSkyHDRI049B_2K_TONEMAPPED.jpg'), file('EveningSkyHDRI049B.png')])
    expect(selectPictures(SKY, sky, undefined).map(picture => picture.name)).toEqual(['EveningSkyHDRI049B_2K_HDR.exr'])
    expect(selectPictures(SKY, sky, ['tonemapped']).map(picture => picture.name)).toEqual(['EveningSkyHDRI049B_2K_TONEMAPPED.jpg'])
  })

  it('names the archive\'s maps when it lacks one the call names, and an archive without maps', () => {
    const pictures = archivePictures(BRICKS, BRICK_FILES)
    expect(() => selectPictures(BRICKS, pictures, ['color', 'metalness'])).toThrow(
      'The archive of Bricks 097 has no "metalness" map; it holds: AmbientOcclusion, Color, Displacement, NormalDX, NormalGL, Roughness.')
    expect(() => selectPictures(BRICKS, [], undefined)).toThrow('The archive of Bricks 097 holds no map pictures; nothing was saved.')
  })
})
