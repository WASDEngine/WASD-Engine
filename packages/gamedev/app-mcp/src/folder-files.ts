/**
 * The files that a process left in a folder, such as the output folder of a script run, for a report.
 * @module
 */

import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** The files of a folder and its subfolders. */
export interface FolderFiles {
  /** Paths relative to the folder, with `/` separators, in name order; at most the listing's limit. */
  readonly files: readonly string[]
  /** How many files the folder and its subfolders hold. */
  readonly totalFiles: number
}

/**
 * List the files in a folder and its subfolders. A folder that does not exist holds no files, since a process may
 * delete the folder that it was given.
 * @param root - absolute folder.
 * @param limit - most paths that the listing names.
 * @returns at most `limit` paths relative to `root` in name order, and how many files it holds.
 */
export async function listFolderFiles(root: string, limit: number): Promise<FolderFiles> {
  let entries
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: [], totalFiles: 0 }
    throw error
  }
  const files = entries
    .filter(entry => entry.isFile())
    .map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
  return { files: files.slice(0, limit), totalFiles: files.length }
}
