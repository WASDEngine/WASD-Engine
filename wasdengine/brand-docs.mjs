#!/usr/bin/env node
/**
 * Name the harness WASD Engine Harness in the hand-written docs and READMEs (fork-owned;
 * wasdengine/FORK.md lists the fork changes). Upstream calls it DeepSeek Harness, which is a
 * registered trademark of DeepSeek (BRAND_GUIDELINES.md), so the fork keeps that name only where
 * a line describes the upstream project itself. Run it after every upstream merge; `--check`
 * lists the lines it would change and exits 1 when there are any.
 *
 * It rewrites Markdown under docs/, every README.md and README.zh.md, AGENTS.md, and SAFETY.md,
 * except the paths in SKIP, fenced code blocks and inline code (they quote literal upstream
 * output or generated reference), and lines that KEEP matches. The app itself is called WASD
 * Engine, so the READMEs under APP_PATHS, which describe what the app shows, use that name instead.
 *
 * The documents in USER_DOCS, which WASD Engine users read, name no DeepSeek product at all. The
 * script cannot rewrite them, so both modes list each of their lines whose visible text says
 * DeepSeek and exit 1 while any is left.
 *
 * Usage: node wasdengine/brand-docs.mjs [--check]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const UPSTREAM_NAME = 'DeepSeek Harness'
const HARNESS_NAME = 'WASD Engine Harness'
const APP_NAME = 'WASD Engine'

/** Packages whose READMEs describe text the app shows, where the brand dictionaries name WASD Engine. */
const APP_PATHS = ['apps/desktop/', 'packages/client/ui-settings-account/', 'packages/experimental/cua/']

/** Path prefixes and files left as upstream wrote them. */
const SKIP = [
  // Upstream's own front page and citation; the fork's front page is .github/README.md.
  'README.md',
  'README.zh.md',
  '.agents/',
  '.github/',
  'snapshots/',
  'wasdengine/',
  // Records of upstream incidents and releases, and translation samples.
  'docs/postmortem/',
  'docs/upgrade-guide/',
  'docs/i18n/style-samples.md',
  // Generated from the CLI and the config schemas; their sources carry the name.
  'docs/cli-help.md',
  'docs/cli-help.zh.md',
  'docs/config-catalog.md',
  'docs/config-catalog.zh.md',
]

/** Lines that name the upstream project on purpose. */
const KEEP = /built on DeepSeek Harness|fork of DeepSeek Harness|trademark|developed by/iu

const FENCE = /^\s*(`{3,}|~{3,})/u

/**
 * The front page and the user guides, whose visible text may not say DeepSeek. Code blocks,
 * inline code, link and image targets, and HTML tags may, because they hold the names users type,
 * such as `@deepseek-ai/` packages, and paths such as the license notice's file.
 */
const USER_DOCS = ['.github/README.md', 'docs/user/guide/']

/**
 * Strip from one prose line what a reader does not see as text.
 * @param {string} line - A line outside fenced code blocks.
 * @returns {string} The line without inline code, link and image targets, and HTML tags.
 */
function visibleText(line) {
  return line.split(/(`+[^`]*`+)/u).filter((_, index) => index % 2 === 0).join('')
    .replace(/\]\([^)]*\)/gu, ']')
    .replace(/<[^>]*>/gu, '')
}

/**
 * List the lines of USER_DOCS whose visible text says DeepSeek.
 * @returns {string[]} One `path:line: text` entry per line.
 */
function userDocLeaks() {
  const pathspecs = USER_DOCS.map(path => path.endsWith('/') ? `${path}*.md` : path)
  const files = execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], { encoding: 'utf8' }).split('\0').filter(path => path !== '')
  const leaks = []
  for (const path of files) {
    let fence
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      const match = FENCE.exec(line)
      if (match) {
        if (fence === undefined) fence = match[1][0]
        else if (match[1][0] === fence) fence = undefined
      } else if (fence === undefined && /deepseek/iu.test(visibleText(line))) {
        leaks.push(`${path}:${index + 1}: ${line.trim()}`)
      }
    })
  }
  return leaks
}

/**
 * List the tracked files this script owns.
 * @returns {string[]} Repository-relative paths.
 */
function brandedFiles() {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'docs/*.md', '*README.md', '*README.zh.md', 'AGENTS.md', 'SAFETY.md', 'SAFETY.zh.md'], { encoding: 'utf8' })
  return files.split('\0').filter(path => path !== '' && !SKIP.some(skip => skip.endsWith('/') ? path.startsWith(skip) : path === skip))
}

/**
 * Rename the product outside inline code spans of one line.
 * @param {string} line - A prose line.
 * @param {string} name - The replacement name.
 * @returns {string} The line with every prose occurrence renamed.
 */
function renameLine(line, name) {
  if (KEEP.test(line)) return line
  return line.split(/(`+[^`]*`+)/u).map((part, index) => index % 2 === 1 ? part : part.replaceAll(UPSTREAM_NAME, name)).join('')
}

/**
 * Rename the product in one Markdown source.
 * @param {string} source - File contents.
 * @param {string} name - The replacement name.
 * @returns {string} Contents with prose occurrences renamed.
 */
export function renameMarkdown(source, name) {
  let fence
  return source.split('\n').map(line => {
    const match = FENCE.exec(line)
    if (match) {
      if (fence === undefined) fence = match[1][0]
      else if (match[1][0] === fence) fence = undefined
      return line
    }
    return fence === undefined ? renameLine(line, name) : line
  }).join('\n')
}

if (import.meta.main) {
  const check = process.argv.includes('--check')
  let changed = 0
  for (const path of brandedFiles()) {
    const source = readFileSync(path, 'utf8')
    if (!source.includes(UPSTREAM_NAME)) continue
    const branded = renameMarkdown(source, APP_PATHS.some(prefix => path.startsWith(prefix)) ? APP_NAME : HARNESS_NAME)
    if (branded === source) continue
    changed++
    if (check) {
      const before = source.split('\n')
      branded.split('\n').forEach((line, index) => {
        if (line !== before[index]) console.log(`${path}:${index + 1}: ${before[index].trim()}`)
      })
    } else {
      writeFileSync(path, branded)
      console.log(`branded ${path}`)
    }
  }
  const leaks = userDocLeaks()
  for (const leak of leaks) console.log(leak)
  if (leaks.length > 0) console.error(`brand-docs: ${leaks.length} line(s) of the front page and user guides say DeepSeek; rewrite them by hand`)
  if (check && changed > 0) console.error(`brand-docs: ${changed} file(s) still name ${UPSTREAM_NAME}; run node wasdengine/brand-docs.mjs`)
  if (!check) console.log(`brand-docs: ${changed} file(s) renamed to ${HARNESS_NAME}.`)
  if ((check && changed > 0) || leaks.length > 0) process.exit(1)
}
