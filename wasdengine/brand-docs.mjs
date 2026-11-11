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

/** Lines that name the upstream project on purpose; `基于 DeepSeek Harness` is the Chinese "built on DeepSeek Harness". */
const KEEP = /built on DeepSeek Harness|fork of DeepSeek Harness|基于 DeepSeek Harness|trademark|developed by/iu

const FENCE = /^\s*(`{3,}|~{3,})/u

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
  if (check && changed > 0) {
    console.error(`brand-docs: ${changed} file(s) still name ${UPSTREAM_NAME}; run node wasdengine/brand-docs.mjs`)
    process.exit(1)
  }
  if (!check) console.log(`brand-docs: ${changed} file(s) renamed to ${HARNESS_NAME}.`)
}
