/** What an asset offers to download and which files one download writes. */
import { describe, expect, it } from 'vitest'
import { parseFileTree } from '../src/api.ts'
import { downloadOptions, fileNameOf, planDownload, safeRelativePath } from '../src/files.ts'
import type { PolyHavenFileTree } from '../src/types.ts'

const MD5 = 'd41d8cd98f00b204e9800998ecf8427e'

function file(url: string, size: number, include?: Record<string, { url: string; size: number }>): Record<string, unknown> {
  return {
    url,
    size,
    md5: MD5,
    ...include === undefined
      ? {}
      : { include: Object.fromEntries(Object.entries(include).map(([path, entry]) => [path, { ...entry, md5: MD5 }])) },
  }
}

const TEXTURE: PolyHavenFileTree = parseFileTree({
  Diffuse: { '1k': { jpg: file('https://dl.test/rock_diff_1k.jpg', 100), exr: file('https://dl.test/rock_diff_1k.exr', 400) }, '2k': { jpg: file('https://dl.test/rock_diff_2k.jpg', 300) } },
  nor_dx: { '1k': { jpg: file('https://dl.test/rock_nor_dx_1k.jpg', 50) } },
  nor_gl: { '1k': { jpg: file('https://dl.test/rock_nor_gl_1k.jpg', 60) } },
  Rough: { '1k': { jpg: file('https://dl.test/rock_rough_1k.jpg', 40) } },
  gltf: { '1k': { gltf: file('https://dl.test/rock_1k.gltf', 10, { 'rock.bin': { url: 'https://dl.test/rock.bin', size: 5 }, 'textures/rock_diff_1k.jpg': { url: 'https://dl.test/rock_diff_1k.jpg', size: 100 } }) } },
  mtlx: { '2k': { mtlx: file('https://dl.test/rock_2k.mtlx', 8) } },
})

const MODEL: PolyHavenFileTree = parseFileTree({
  Diffuse: { '1k': { jpg: file('https://dl.test/chair_diff_1k.jpg', 100) } },
  gltf: {
    '2k': { gltf: file('https://dl.test/chair_2k.gltf', 20, { 'chair.bin': { url: 'https://dl.test/chair.bin', size: 50 } }) },
    '1k': { gltf: file('https://dl.test/chair_1k.gltf', 10, { 'chair.bin': { url: 'https://dl.test/chair.bin', size: 50 } }) },
  },
  usd: { '4k': { usd: file('https://dl.test/chair_4k.usdc', 70) } },
})

const HDRI: PolyHavenFileTree = parseFileTree({
  hdri: { '4k': { hdr: file('https://dl.test/sky_4k.hdr', 4000) }, '2k': { hdr: file('https://dl.test/sky_2k.hdr', 2000), exr: file('https://dl.test/sky_2k.exr', 1800) } },
  tonemapped: file('https://dl.test/sky.jpg', 900),
  backplates: { DSC1: { jpg_plain: file('https://dl.test/DSC1.jpg', 50) } },
})

describe('parseFileTree', () => {
  it('keeps the files three levels down, and drops single files and files whose references cannot be read', () => {
    const tree = parseFileTree({
      tonemapped: file('https://dl.test/sky.jpg', 1),
      Diffuse: { '1k': { jpg: file('https://dl.test/a.jpg', 1), png: { url: 'https://dl.test/a.png' } } },
      gltf: { '1k': { gltf: { ...file('https://dl.test/a.gltf', 1), include: { 'a.bin': { url: 'https://dl.test/a.bin', size: 1 } } } } },
    })
    expect([...tree.keys()]).toEqual(['Diffuse'])
    expect([...tree.get('Diffuse')?.get('1k')?.keys() ?? []]).toEqual(['jpg'])
    expect(tree.get('Diffuse')?.get('1k')?.get('jpg')).toEqual({ url: 'https://dl.test/a.jpg', size: 1, md5: MD5, include: {} })
  })
})

describe('downloadOptions', () => {
  it('sizes a texture\'s map formats by its default maps, which leave out the DirectX normal map, and its materials with their references', () => {
    const options = downloadOptions('texture', TEXTURE)
    expect(options.maps).toEqual(['Diffuse', 'nor_dx', 'nor_gl', 'Rough'])
    expect(options.defaultMaps).toEqual(['Diffuse', 'nor_gl', 'Rough'])
    expect(options.formats).toEqual([
      { format: 'jpg', resolutions: [{ resolution: '1k', bytes: 200, files: 3 }, { resolution: '2k', bytes: 300, files: 1 }] },
      { format: 'exr', resolutions: [{ resolution: '1k', bytes: 400, files: 1 }] },
      { format: 'gltf', resolutions: [{ resolution: '1k', bytes: 115, files: 3 }] },
      { format: 'mtlx', resolutions: [{ resolution: '2k', bytes: 8, files: 1 }] },
    ])
  })

  it('offers a model\'s ready-made formats, smallest resolution first, and an HDRI\'s panoramas', () => {
    expect(downloadOptions('model', MODEL)).toEqual({
      maps: [],
      defaultMaps: [],
      formats: [
        { format: 'gltf', resolutions: [{ resolution: '1k', bytes: 60, files: 2 }, { resolution: '2k', bytes: 70, files: 2 }] },
        { format: 'usd', resolutions: [{ resolution: '4k', bytes: 70, files: 1 }] },
      ],
    })
    expect(downloadOptions('hdri', HDRI).formats).toEqual([
      { format: 'hdr', resolutions: [{ resolution: '2k', bytes: 2000, files: 1 }, { resolution: '4k', bytes: 4000, files: 1 }] },
      { format: 'exr', resolutions: [{ resolution: '2k', bytes: 1800, files: 1 }] },
    ])
  })
})

describe('planDownload', () => {
  it('downloads a texture\'s default jpg maps at 1k by default', () => {
    const plan = planDownload('Rock', 'texture', TEXTURE, {})
    expect(plan).toMatchObject({ format: 'jpg', resolution: '1k', maps: ['Diffuse', 'nor_gl', 'Rough'] })
    expect(plan.entry).toBeUndefined()
    expect(plan.files.map(planned => planned.path)).toEqual(['rock_diff_1k.jpg', 'rock_nor_gl_1k.jpg', 'rock_rough_1k.jpg'])
  })

  it('skips default maps the resolution lacks, and fails for a named one', () => {
    expect(planDownload('Rock', 'texture', TEXTURE, { resolution: '2k' }).maps).toEqual(['Diffuse'])
    expect(() => planDownload('Rock', 'texture', TEXTURE, { resolution: '2k', maps: ['Rough'] })).toThrow('Rock has no jpg Rough map at 2k.')
    expect(planDownload('Rock', 'texture', TEXTURE, { maps: ['nor_dx'] }).files.map(planned => planned.path)).toEqual(['rock_nor_dx_1k.jpg'])
  })

  it('writes a model\'s gltf with its references at the paths it names, entry first', () => {
    const plan = planDownload('Chair', 'model', MODEL, {})
    expect(plan).toMatchObject({ format: 'gltf', resolution: '1k', entry: 'chair_1k.gltf', maps: [] })
    expect(plan.files.map(planned => [planned.path, planned.file.url])).toEqual([['chair_1k.gltf', 'https://dl.test/chair_1k.gltf'], ['chair.bin', 'https://dl.test/chair.bin']])
    const material = planDownload('Rock', 'texture', TEXTURE, { format: 'gltf' })
    expect(material.files.map(planned => planned.path)).toEqual(['rock_1k.gltf', 'rock.bin', 'textures/rock_diff_1k.jpg'])
  })

  it('takes the smallest resolution when the format has no 1k, and an HDRI\'s hdr by default', () => {
    expect(planDownload('Chair', 'model', MODEL, { format: 'usd' })).toMatchObject({ resolution: '4k', entry: 'chair_4k.usdc' })
    expect(planDownload('Sky', 'hdri', HDRI, {})).toMatchObject({ format: 'hdr', resolution: '2k', entry: 'sky_2k.hdr', files: [{ path: 'sky_2k.hdr' }] })
  })

  it('names what the asset offers when it lacks the format, the resolution, or a map', () => {
    expect(() => planDownload('Chair', 'model', MODEL, { format: 'blend' })).toThrow('Chair has no blend files; it offers gltf and usd.')
    expect(() => planDownload('Chair', 'model', MODEL, { resolution: '8k' })).toThrow('Chair has no gltf files at 8k; it offers 1k and 2k.')
    expect(() => planDownload('Rock', 'texture', TEXTURE, { maps: ['Metal', 'AO'] })).toThrow('Rock has no Metal and AO maps; its maps are Diffuse, nor_dx, nor_gl, and Rough.')
    expect(() => planDownload('Rock', 'texture', TEXTURE, { maps: [] })).toThrow('maps must name at least one map.')
    expect(() => planDownload('Chair', 'model', MODEL, { maps: ['Diffuse'] })).toThrow('maps applies only to the jpg, png, and exr texture maps, not to gltf.')
    expect(() => planDownload('Empty', 'model', parseFileTree({}), {})).toThrow('Empty has no files that polyhaven_download can fetch.')
  })

  it('stops for a referenced path that would leave the download folder', () => {
    const tree = parseFileTree({ gltf: { '1k': { gltf: file('https://dl.test/x.gltf', 1, { '../../.zshrc': { url: 'https://dl.test/x', size: 1 } }) } } })
    expect(() => planDownload('X', 'model', tree, {})).toThrow('Poly Haven named a file "../../.zshrc", which would leave the download folder; the download stopped.')
  })

  it('writes a file two entries share once, and stops when one path names two different files', () => {
    const shared = parseFileTree({ gltf: { '1k': { gltf: file('https://dl.test/x.gltf', 1, { 'x.gltf': { url: 'https://dl.test/x.gltf', size: 1 } }) } } })
    expect(planDownload('X', 'model', shared, {}).files.map(planned => planned.path)).toEqual(['x.gltf'])
    const clash = parseFileTree({ gltf: { '1k': { gltf: { ...file('https://dl.test/x.gltf', 1), include: { 'X.GLTF': { url: 'https://dl.test/y', size: 1, md5: 'ffffffffffffffffffffffffffffffff' } } } } } })
    expect(() => planDownload('X', 'model', clash, {})).toThrow('Poly Haven names two different files "X.GLTF" in one download; the download stopped.')
  })
})

describe('paths', () => {
  it('accepts plain relative paths and refuses every path that could leave the folder', () => {
    expect(safeRelativePath('textures/a_1k.jpg')).toBe('textures/a_1k.jpg')
    for (const path of ['', '/etc/passwd', '../a', 'a/../../b', 'a//b', './a', 'a\\..\\b', 'C:a', 'a\0b']) {
      expect(() => safeRelativePath(path), path).toThrow(/would leave the download folder/u)
    }
  })

  it('takes a file name from the URL\'s last segment, decoded, and refuses an encoded separator', () => {
    expect(fileNameOf('https://dl.test/HDRIs/extra/Tonemapped%20JPG/sky.jpg?v=1')).toBe('sky.jpg')
    expect(fileNameOf('https://dl.test/a/My%20Chair_1k.gltf')).toBe('My Chair_1k.gltf')
    expect(() => fileNameOf('https://dl.test/a/..%2F..%2Fb')).toThrow(/would leave the download folder/u)
    expect(() => fileNameOf('https://dl.test/a/')).toThrow(/would leave the download folder/u)
    expect(() => fileNameOf('not a url')).toThrow('Poly Haven named a file at "not a url", which has no file name; the download stopped.')
  })
})
