/**
 * Helpers for the plugins that offer game tools through this server: the account's access to the gateway, the files a
 * call names and writes, the parts of a tool result, the tools a connected agent calls with a game project's folder,
 * and what the plugins that download from an asset library share. The kit imports only Node built-ins and types, so a
 * plugin that imports it bundles it without this plugin's server, which `tests/kit.spec.ts` checks.
 * @module @deepseek-ai/dsh-game-mcp/kit
 */
export {
  accountAccess, ATTACHED_IMAGE_SCHEMA, checkedInteger, folderRows, gatewayOrigin, isNetworkPath, kilobytes, modelSeesImages,
  namedFileSize, pathFolder, pathName, pathWithin, replaceableFile, sessionFiles, stateChanges, statOf, textBlocks, windowPath,
  writeWhole, type GatewayAccess,
} from './plugin-kit.ts'
export { callFolder, PROJECT_PARAMETER, projectMcpTool, type CallFolders, type ResultImage } from './project-tools.ts'
export {
  AssetLibraryClient, AssetLibraryHttp, AssetLibraryRequestError, connectedLibraryTools, downloadFolders, saveBody, savedCounts,
  sessionPreviews, shownPreview, writeAssetFiles, WRITTEN_FILES_SCHEMA,
  type AssetFileStatus, type AssetFileWrite, type AssetLibraryClientOptions, type AssetLibraryHttpOptions, type ConnectedDownload,
  type PreviewImage, type PreviewMediaType, type PreviewStore, type PreviewSurface, type ShownPreview, type WrittenAssetFile,
} from './asset-library.ts'
