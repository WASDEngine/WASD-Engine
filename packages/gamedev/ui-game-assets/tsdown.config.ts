import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../client/tsdown.client.ts'

/**
 * `./client/project-tab`, the project walk and tab state that the Audio tab shares, is a bundle of its own rather than a
 * compiled module, because publishing the compiled modules would publish the views, which import style sheets that the
 * package does not publish. React stays an import, as in the compiled module, so a bundle that inlines the entry or a
 * program that imports it supplies the one React its hooks need. The Audio tab's browser bundle inlines the module from
 * its source through the tsconfig path alias, so it does not wait for this bundle, which the Client pass builds at the
 * same time.
 */
const projectTab: UserConfig = {
  entry: { 'project-tab': 'lib/types/client/project-tab.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'neutral',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { neverBundle: ['react'] },
}

export default clientBundle(import.meta.dirname, ['lib/types/index.js'], { companions: [projectTab] })
