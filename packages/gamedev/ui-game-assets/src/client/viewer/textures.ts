/**
 * The textures of one model, each checked before it is decoded. A texture's file is counted against the bytes the
 * viewer reads for the textures of one model, before it is read when the response states its length, then fetched
 * whole, its header checked against the viewer's pixel cap, and the memory it takes decoded counted against the memory
 * the viewer gives those textures; only a texture that passes is decoded, and from the bytes that were checked, so a
 * file that changes in between cannot slip past the check. OBJ material libraries and FBX files ask the loading manager for a
 * texture loader by the texture's name, and get {@link CheckedTextureLoader} for every texture, an FBX file's embedded
 * images included, which arrive as `blob:` or `data:` URLs. A Collada file's loader decodes its images with loaders of
 * its own, so {@link CheckedTextures.prefetch} checks them before the file is parsed and hands that loader the checked
 * bytes by `blob:` URL.
 */
import {
  ClampToEdgeWrapping, DataTexture, ImageLoader, LinearFilter, LinearMipmapLinearFilter, Loader, Texture, type DataTextureLoaderTexData,
  type LoadingManager,
} from 'three'
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js'

/** The memory budget the textures of one model share, and the header check of each texture. */
export class TextureBudget {
  private used = 0
  private fetched = 0

  /**
   * @param maxBytes - the most memory the model's textures take decoded, and the most their files take together.
   * @param check - the header check: it throws for an image the viewer does not decode, and returns the bytes the
   * image takes decoded otherwise.
   */
  constructor(
    private readonly maxBytes: number,
    private readonly check: (data: Uint8Array, name: string) => number,
  ) {}

  /**
   * Count a texture file's bytes, before they are read when the response states its length.
   * @param bytes - the file's size.
   * @throws {Error} when the model's texture files would take more than the budget together.
   */
  reserve(bytes: number): void {
    if (this.fetched + bytes > this.maxBytes) {
      throw new Error(`the model's texture files would take more than the ${String(this.maxBytes)} bytes the viewer reads for one model`)
    }
    this.fetched += bytes
  }

  /**
   * Check one texture and count the memory it takes decoded.
   * @param data - the image file.
   * @param name - a name whose extension picks the header to read, as the model's loader picks its decoder.
   * @throws {Error} when the header check refuses the image, or when it would take the model's textures past the budget.
   */
  take(data: Uint8Array, name: string): void {
    const bytes = this.check(data, name)
    if (this.used + bytes > this.maxBytes) {
      throw new Error(`the model's textures would take more than the ${String(this.maxBytes)} bytes the viewer decodes for one model`)
    }
    this.used += bytes
  }
}

/**
 * Fetch a texture file's bytes, counting them against the model's texture budget: a response that states its length
 * before its body is read.
 * @throws {Error} for a URL that loads nothing, such as the viewer's refusal URL, a failed response, or a file past
 * the budget.
 */
async function fetchBytes(url: string, budget: TextureBudget, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url, { signal, credentials: 'same-origin' })
  if (!response.ok) throw new Error(`the texture could not be loaded (${String(response.status)})`)
  const length = response.headers.get('Content-Length')
  const stated = length === null ? Number.NaN : Number(length)
  if (Number.isSafeInteger(stated)) {
    try {
      budget.reserve(stated)
    } catch (error) {
      void response.body?.cancel()
      throw error
    }
  }
  const data = new Uint8Array(await response.arrayBuffer())
  if (!Number.isSafeInteger(stated)) budget.reserve(data.byteLength)
  else if (data.byteLength > stated) budget.reserve(data.byteLength - stated)
  return data
}

/** Apply parsed texture data as three.js's DataTextureLoader applies it, with the defaults it gives absent fields. */
function applyTexData(texture: DataTexture, texData: DataTextureLoaderTexData): void {
  if (texData.image !== undefined) texture.image = texData.image
  else if (texData.data !== undefined && texData.width !== undefined && texData.height !== undefined) {
    texture.image = { data: texData.data, width: texData.width, height: texData.height }
  }
  texture.wrapS = texData.wrapS ?? ClampToEdgeWrapping
  texture.wrapT = texData.wrapT ?? ClampToEdgeWrapping
  texture.magFilter = texData.magFilter ?? LinearFilter
  texture.minFilter = texData.minFilter ?? LinearFilter
  texture.anisotropy = texData.anisotropy ?? 1
  if (texData.colorSpace !== undefined) texture.colorSpace = texData.colorSpace
  if (texData.flipY !== undefined) texture.flipY = texData.flipY
  if (texData.format !== undefined) texture.format = texData.format
  if (texData.type !== undefined) texture.type = texData.type
  if (texData.mipmaps !== undefined) {
    texture.mipmaps = texData.mipmaps
    texture.minFilter = LinearMipmapLinearFilter
  }
  if (texData.mipmapCount === 1) texture.minFilter = LinearFilter
  if (texData.generateMipmaps !== undefined) texture.generateMipmaps = texData.generateMipmaps
  texture.needsUpdate = true
}

/**
 * Decode checked bytes into a texture as three.js's own loaders decode them: a TGA file into a DataTexture's pixels,
 * as TGALoader does, and any other image into an image element, as TextureLoader does.
 */
async function decodeInto(texture: Texture, data: Uint8Array<ArrayBuffer>): Promise<void> {
  if (texture instanceof DataTexture) {
    applyTexData(texture, new TGALoader().parse(data.buffer))
    return
  }
  const url = URL.createObjectURL(new Blob([data]))
  try {
    texture.image = await new ImageLoader().loadAsync(url)
    texture.needsUpdate = true
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** The checked textures of one model. */
export class CheckedTextures {
  /** `blob:` URLs of the checked bytes of a Collada file's images, by the name the file stores. */
  private readonly prefetched = new Map<string, string>()

  /**
   * @param budget - the model's texture budget.
   * @param signal - cancellation of the model's read.
   */
  constructor(private readonly budget: TextureBudget, private readonly signal: AbortSignal) {}

  /**
   * Fetch and check the images a Collada file names before its loader runs. An image that cannot be fetched, or that the
   * check refuses, is reported and gets no checked URL, so its loader loads nothing.
   * @param names - the names its images give, as its loader requests them.
   * @param resolve - the URL a name loads from, or undefined for a file the viewer does not load.
   * @param refused - told the name of each image that fails.
   * @returns once every image is checked or refused; rejects with the signal's reason once it aborts.
   */
  async prefetch(names: readonly string[], resolve: (name: string) => string | undefined, refused: (name: string) => void): Promise<void> {
    for (const name of new Set(names)) {
      this.signal.throwIfAborted()
      const url = resolve(name)
      try {
        if (url === undefined) throw new Error('the viewer does not load this file')
        const data = await fetchBytes(url, this.budget, this.signal)
        this.budget.take(data, name)
        this.prefetched.set(name, URL.createObjectURL(new Blob([data])))
      } catch (error) {
        this.signal.throwIfAborted()
        void error
        // Error or TypeError: an image that cannot be fetched or that the check refuses shows as missing.
        refused(name)
      }
    }
  }

  /**
   * The URL a Collada file's image loads from.
   * @param name - the name the file stores.
   * @returns the `blob:` URL of its checked bytes, or undefined for an image that was refused or never checked.
   */
  checked(name: string): string | undefined {
    return this.prefetched.get(name)
  }

  /**
   * Load one texture: fetch it, check it, and decode the checked bytes into it.
   * @param texture - the texture to fill, which the loader has already handed to the model; a DataTexture is read as TGA.
   * @param url - the URL to fetch it from.
   * @param name - a name whose extension picks the header to read.
   * @returns once the texture is filled.
   * @throws {Error} when it cannot be fetched, the check refuses it, or it does not decode.
   */
  async load(texture: Texture, url: string, name: string): Promise<void> {
    const data = await fetchBytes(url, this.budget, this.signal)
    this.budget.take(data, name)
    this.signal.throwIfAborted()
    await decodeInto(texture, data)
  }

  /** Release the `blob:` URLs of the prefetched images; a model's images decoded from them keep their pixels. */
  dispose(): void {
    for (const url of this.prefetched.values()) URL.revokeObjectURL(url)
    this.prefetched.clear()
  }
}

/** Whether a texture is read as TGA, which three.js decodes itself, or as an image the browser decodes. */
export type CheckedTextureKind = 'tga' | 'image'

/** The name a TGA texture is checked by when its URL names no file, as an FBX file's embedded image does. */
const EMBEDDED_TGA = 'embedded.tga'

/**
 * The texture loader a model's manager hands OBJ material libraries and FBX files for every texture: it returns the
 * texture at once, as three.js's loaders do, and fills it once the texture is fetched, checked, and decoded. A
 * texture that fails stays empty and reports its failure to the manager, which lists it as missing.
 */
export class CheckedTextureLoader extends Loader<Texture> {
  /**
   * @param manager - the model's loading manager, whose URL resolution gives each texture's URL.
   * @param textures - the model's checked textures.
   * @param kind - how the textures this loader is handed decode: the manager hands TGA names to a `tga` loader.
   */
  constructor(manager: LoadingManager, private readonly textures: CheckedTextures, private readonly kind: CheckedTextureKind) {
    super(manager)
  }

  /**
   * Start loading one texture.
   * @param url - the name the model stores, or an embedded image's `blob:` or `data:` URL.
   * @param onLoad - told the texture once it is filled.
   * @param onProgress - unused: the texture arrives whole.
   * @param onError - told why the texture failed.
   * @returns the texture, empty until it is filled.
   */
  override load(
    url: string,
    onLoad?: (texture: Texture) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ): Texture {
    void onProgress
    const texture = this.kind === 'tga' ? new DataTexture() : new Texture()
    // An FBX file's loader clears the path for an embedded image, which three.js's loaders then leave out.
    const path: unknown = this.path
    const resolved = this.manager.resolveURL(typeof path === 'string' ? `${path}${url}` : url)
    const name = this.kind === 'tga' && !/\.tga$/iu.test(url.split(/[?#]/u)[0] ?? url) ? EMBEDDED_TGA : url
    this.manager.itemStart(resolved)
    void this.textures.load(texture, resolved, name).then(() => {
      onLoad?.(texture)
      this.manager.itemEnd(resolved)
    }, (error: unknown) => {
      onError?.(error)
      this.manager.itemError(resolved)
      this.manager.itemEnd(resolved)
    })
    return texture
  }
}
