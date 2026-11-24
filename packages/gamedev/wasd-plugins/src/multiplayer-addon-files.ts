/**
 * The files of every WASD Multiplayer add-on that WASD Engine shipped, which tell a project's unchanged copy of the
 * add-on from one that its game changed.
 * @module @deepseek-ai/dsh-wasd-plugins/src/multiplayer-addon-files
 */
import { createHash } from 'node:crypto'
import { extname } from 'node:path'

/** Extensions of the add-on's text files, whose digests read line endings as LF. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['.gd', '.cfg', '.tscn', '.tres', '.gdshader', '.json', '.txt'])

/**
 * The digest that {@link SHIPPED_ADDON_FILES} records for a file of the add-on: the SHA-256 of its bytes, with CRLF line
 * endings read as LF in a text file, so a copy that a Windows checkout gave CRLF endings still counts as unchanged.
 * @param path - the file's path in the add-on folder, with forward slashes.
 * @param bytes - the file's content.
 * @returns the hexadecimal digest.
 */
export function addonFileDigest(path: string, bytes: Uint8Array): string {
  const text = TEXT_EXTENSIONS.has(extname(path).toLowerCase())
  const content = text ? Buffer.from(Buffer.from(bytes).toString('utf8').replaceAll('\r\n', '\n'), 'utf8') : bytes
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Every set of files that WASD Engine shipped as the WASD Multiplayer add-on, by the version its `plugin.cfg` names:
 * each file's path in the add-on folder with its {@link addonFileDigest}. Markdown files are left out, since they
 * document the add-on and may change within a version. 1.2.0 shipped two sets: WASD Engine 0.2.4 changed its files
 * without a new version. A release of a WASD Engine records the add-on it ships under that add-on's version for good,
 * and a later change of the add-on's files takes a new version; `tests/multiplayer-addon-files.spec.ts` checks that the
 * add-on in `addon/wasd_multiplayer/` is recorded under its version.
 */
export const SHIPPED_ADDON_FILES: Readonly<Record<string, readonly Readonly<Record<string, string>>[]>> = {
  '1.0.0': [
    {
      'examples/lobby_menu.gd': '731b86ff8ca90428b6b71437ee4268cd5ef3bb88fa41bf873f8339c39f83d2e5',
      'examples/lobby_menu.tscn': '6756e02ebda7dec377d9768a871ba350f55a8840848126413a4423566e75d65a',
      'internal/api.gd': '8483210e9892e4f7530ce3924f674da84653571395ddd8ee843fc08413372211',
      'internal/config.gd': '9d7f2279d78646825f6f7b40d4562f38d5a89d91905b3fa1c7834f8202648d24',
      'internal/counting_peer.gd': '7e0361de6b987c4af0aa25e1a5d90b1fccbb9b35fc4dc4b2dc814aaef864a136',
      'internal/server_files.gd': 'd0f186f421b838b3e5f82e318e93a15d3f1c1e78a1ef92b8e14078a313bb20be',
      'internal/signal_client.gd': 'cb55fb9468437e668e7d610f148f8e917de7aca8cd84e1bdbeedd179f26b1779',
      'internal/tokens.gd': '44f7cd8a2725ad85e8ff48d3357913d2a98caab6e66cdb246edf415c5d8f9826',
      'internal/web_bridge.gd': '2735482d9f4080bea200b460e49e5f2a28cde2a7c600acd8379c38450d785692',
      'plugin.cfg': 'cd11608de87ec88084b5dd32879b353763bfbc339871333ce2741130fe9de743',
      'plugin.gd': '51251ff3e0555ad127ebb75bd4aac328ef08ea824e445a59a273a5dcc9664b1e',
      'wasd_multiplayer.gd': '4cce3d3daf0b120a35dc88858f5f3538236ad5b97760989517dce4b1fb09c3b8',
    },
  ],
  '1.1.0': [
    {
      'examples/lobby_menu.gd': '731b86ff8ca90428b6b71437ee4268cd5ef3bb88fa41bf873f8339c39f83d2e5',
      'examples/lobby_menu.tscn': '6756e02ebda7dec377d9768a871ba350f55a8840848126413a4423566e75d65a',
      'internal/api.gd': '8483210e9892e4f7530ce3924f674da84653571395ddd8ee843fc08413372211',
      'internal/config.gd': '9d7f2279d78646825f6f7b40d4562f38d5a89d91905b3fa1c7834f8202648d24',
      'internal/counting_peer.gd': '7e0361de6b987c4af0aa25e1a5d90b1fccbb9b35fc4dc4b2dc814aaef864a136',
      'internal/server_files.gd': 'd0f186f421b838b3e5f82e318e93a15d3f1c1e78a1ef92b8e14078a313bb20be',
      'internal/signal_client.gd': '645bba006c8a2e27869710c23452e2c6db148cfb713fdfee1c849fbea919936f',
      'internal/tokens.gd': '44f7cd8a2725ad85e8ff48d3357913d2a98caab6e66cdb246edf415c5d8f9826',
      'internal/web_bridge.gd': 'c05b8a7e27a9327b75e6b9fa669277a6e00918bbde06b72b5c37d46ad2434bb7',
      'plugin.cfg': '5de1a6d676a1e57ca5b2c4803b70286600b06b7f7b4187e56eb1934decdf3dc1',
      'plugin.gd': '51251ff3e0555ad127ebb75bd4aac328ef08ea824e445a59a273a5dcc9664b1e',
      'wasd_multiplayer.gd': '2e0be2e6c8ec0c6fbd08e090a5ae171d991d05a4c8c55e1682cbd7a1f2daf560',
    },
  ],
  '1.2.0': [
    {
      'examples/lobby_menu.gd': '731b86ff8ca90428b6b71437ee4268cd5ef3bb88fa41bf873f8339c39f83d2e5',
      'examples/lobby_menu.tscn': '6756e02ebda7dec377d9768a871ba350f55a8840848126413a4423566e75d65a',
      'internal/api.gd': '8483210e9892e4f7530ce3924f674da84653571395ddd8ee843fc08413372211',
      'internal/config.gd': '9d7f2279d78646825f6f7b40d4562f38d5a89d91905b3fa1c7834f8202648d24',
      'internal/counting_peer.gd': '7e0361de6b987c4af0aa25e1a5d90b1fccbb9b35fc4dc4b2dc814aaef864a136',
      'internal/server_files.gd': 'd0f186f421b838b3e5f82e318e93a15d3f1c1e78a1ef92b8e14078a313bb20be',
      'internal/signal_client.gd': '645bba006c8a2e27869710c23452e2c6db148cfb713fdfee1c849fbea919936f',
      'internal/tokens.gd': '44f7cd8a2725ad85e8ff48d3357913d2a98caab6e66cdb246edf415c5d8f9826',
      'internal/web_bridge.gd': 'c05b8a7e27a9327b75e6b9fa669277a6e00918bbde06b72b5c37d46ad2434bb7',
      'plugin.cfg': 'ab548a5c092997db0efc0521ceab533880cb99a9db85742b1d013dd0d8d32c2b',
      'plugin.gd': '51251ff3e0555ad127ebb75bd4aac328ef08ea824e445a59a273a5dcc9664b1e',
      'wasd_multiplayer.gd': '3f89dba2808c333eb17fa3cfcf1c9628e8ca5817f41fc20b0f0036d4b5c16c14',
    },
    {
      'examples/lobby_menu.gd': '731b86ff8ca90428b6b71437ee4268cd5ef3bb88fa41bf873f8339c39f83d2e5',
      'examples/lobby_menu.tscn': '6756e02ebda7dec377d9768a871ba350f55a8840848126413a4423566e75d65a',
      'internal/api.gd': '0f952f690d985a75ba163873c6cd4c38917bf474d374aacf51a510c64033df4d',
      'internal/config.gd': '9fb6ab8753e7c2921f9af3736f44c07b1c4b0120bdf9111594a493043d21476a',
      'internal/counting_peer.gd': '7e0361de6b987c4af0aa25e1a5d90b1fccbb9b35fc4dc4b2dc814aaef864a136',
      'internal/server_files.gd': 'd0f186f421b838b3e5f82e318e93a15d3f1c1e78a1ef92b8e14078a313bb20be',
      'internal/signal_client.gd': '645bba006c8a2e27869710c23452e2c6db148cfb713fdfee1c849fbea919936f',
      'internal/tokens.gd': '44f7cd8a2725ad85e8ff48d3357913d2a98caab6e66cdb246edf415c5d8f9826',
      'internal/web_bridge.gd': 'c05b8a7e27a9327b75e6b9fa669277a6e00918bbde06b72b5c37d46ad2434bb7',
      'plugin.cfg': 'ab548a5c092997db0efc0521ceab533880cb99a9db85742b1d013dd0d8d32c2b',
      'plugin.gd': '51251ff3e0555ad127ebb75bd4aac328ef08ea824e445a59a273a5dcc9664b1e',
      'wasd_multiplayer.gd': 'ab9d06375764afb6f905b7ed456fb2868c013896437e335d8b68067234a8bd87',
    },
  ],
  '1.3.0': [
    {
      'examples/lobby_menu.gd': '731b86ff8ca90428b6b71437ee4268cd5ef3bb88fa41bf873f8339c39f83d2e5',
      'examples/lobby_menu.tscn': '6756e02ebda7dec377d9768a871ba350f55a8840848126413a4423566e75d65a',
      'internal/api.gd': '7ac2dffbd18fdb714a60e83801c458172dd8c279b3305840355f2ea4f250b443',
      'internal/config.gd': 'e59cb9a7dce25751887f4d4f9b8bfecd8176b140ac89db68177bf8a072a54b3f',
      'internal/counting_peer.gd': '7e0361de6b987c4af0aa25e1a5d90b1fccbb9b35fc4dc4b2dc814aaef864a136',
      'internal/server_files.gd': 'd0f186f421b838b3e5f82e318e93a15d3f1c1e78a1ef92b8e14078a313bb20be',
      'internal/signal_client.gd': '645bba006c8a2e27869710c23452e2c6db148cfb713fdfee1c849fbea919936f',
      'internal/tokens.gd': '44f7cd8a2725ad85e8ff48d3357913d2a98caab6e66cdb246edf415c5d8f9826',
      'internal/web_bridge.gd': 'fe466bd7bdcefefe49880f266b7a97946049db03bace164cbf662606d709ee84',
      'plugin.cfg': '705fec5fc81c334eaf9050464ef4af9a4df93a4f1a53619a3feaf64d8c0cb880',
      'plugin.gd': '51251ff3e0555ad127ebb75bd4aac328ef08ea824e445a59a273a5dcc9664b1e',
      'wasd_multiplayer.gd': '562528f42eba921ad9c3b74466f7d4605975b37f8115ab2815dab709b3c8283f',
    },
  ],
}

/** The digests each path of the add-on folder had in any shipped add-on. */
const SHIPPED_DIGESTS: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const digests = new Map<string, Set<string>>()
  for (const files of Object.values(SHIPPED_ADDON_FILES).flat()) {
    for (const [path, digest] of Object.entries(files)) {
      const known = digests.get(path) ?? new Set<string>()
      known.add(digest)
      digests.set(path, known)
    }
  }
  return digests
})()

/**
 * Whether a file of a project's add-on folder is one that WASD Engine shipped at that path, in any version.
 * @param path - the file's path in the add-on folder, with forward slashes.
 * @param digest - its {@link addonFileDigest}.
 * @returns true for a shipped file, false for a file the game changed or added.
 */
export function isShippedAddonFile(path: string, digest: string): boolean {
  return SHIPPED_DIGESTS.get(path)?.has(digest) === true
}

/**
 * Whether an add-on version shipped a file at a path.
 * @param version - the version, as a `plugin.cfg` names it.
 * @param path - the path in the add-on folder, with forward slashes.
 * @returns true when a set of files recorded under `version` has a file there.
 */
export function shippedAddonHas(version: string, path: string): boolean {
  return (SHIPPED_ADDON_FILES[version] ?? []).some(files => Object.hasOwn(files, path))
}
