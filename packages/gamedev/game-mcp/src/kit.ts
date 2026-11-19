/**
 * Helpers for the plugins that offer game tools through this server: the account's access to the gateway, the files a
 * call names and writes, the parts of a tool result, and the tools a connected agent calls with a game project's
 * folder. The kit imports only Node built-ins and types, so a plugin that imports it bundles it without this plugin's
 * server, which `tests/kit.spec.ts` checks.
 * @module @deepseek-ai/dsh-game-mcp/kit
 */
export {
  accountAccess, ATTACHED_IMAGE_SCHEMA, checkedInteger, folderRows, gatewayOrigin, isNetworkPath, kilobytes, modelSeesImages,
  namedFileSize, pathFolder, pathName, pathWithin, replaceableFile, reservePath, sessionFiles, stateChanges, statOf, textBlocks,
  windowPath, writeWhole, type GatewayAccess, type Reservation,
} from './plugin-kit.ts'
export { callFolder, PROJECT_PARAMETER, projectMcpTool, type CallFolders, type ResultImage } from './project-tools.ts'
