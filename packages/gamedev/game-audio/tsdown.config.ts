import { defineConfig } from 'tsdown'

/** Build the runtime as a self-contained package export; `./audio` is served from the compiler's output. */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
