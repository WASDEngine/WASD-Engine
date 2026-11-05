/** Ordinary release entry; qualification imports the environment-independent factory. */
import { createElectronBuilderConfig } from './scripts/electron-builder-config.mjs'
import { applyWasdengineBrand } from './scripts/wasdengine-builder-config.mjs'

export { createElectronBuilderConfig }
// electron-builder calls a function default export when it loads the configuration, so importing the factory evaluates nothing.
export default () => applyWasdengineBrand(createElectronBuilderConfig())
