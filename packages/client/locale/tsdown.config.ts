import type { UserConfig } from 'tsdown'
import { clientBundle } from '../tsdown.client.ts'

/**
 * WASDEngine fork: `./brand`, the helper that the client bundles of the namespaces the fork words differently inline,
 * is a bundle of its own rather than a compiled module, because publishing the compiled modules would publish
 * `LanguageRow.js`, which imports a style sheet that the package does not publish. The Host pass builds it from the Host
 * program's compile of the helper, so it exists before the Client pass bundles that inline it; with `hostPhase` the
 * Node half, whose only runtime package import is the production dependency `@deepseek-ai/schemastery`, builds in the
 * Host pass too (wasdengine/FORK.md).
 */
const brand: UserConfig = {
  entry: { brand: 'lib/types/client/wasdengine-brand.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

export default clientBundle(import.meta.dirname, ['lib/types/index.js'], { hostPhase: true, companions: [brand] })
