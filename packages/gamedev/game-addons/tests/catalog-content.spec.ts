/**
 * The add-on catalog that WASD Engine ships, beside the gamedev preset in the Web app bundle: every entry loads, was
 * verified with the shipped runtimes, has a smoke test for the end-to-end suite, an icon for the Add-ons dialog, and a
 * guide whose skill tool result fits under the gamedev preset's tool-result pruner threshold, so a long Session never
 * trims a guide.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'
import { GUIDE_FILE, loadCatalog, parseGuide } from '../src/catalog.ts'
import { BUNDLED_SKILLS_DIR, CATALOG_DIR, ICON_NOTICES, SMOKE_DIR, SmokeSpec } from './shipped-catalog.ts'

/** The catalog folder inside the installed macOS app, which the skill tool result names. */
const INSTALLED_CATALOG = '/Applications/WASD Engine.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/wasdengine/addons'
/** `thresholdChars` of the gamedev preset's tool-result pruner (`wasdengine/gamedev.cordis.patch.yml`). */
const PRUNER_THRESHOLD = 8192
/** Longest skill description the Session catalog shows (`dsh-tool-skill`'s `catalogDescriptionMaxLength`). */
const DESCRIPTION_LIMIT = 500

describe('the shipped add-on catalog', () => {
  it('loads, with each entry verified on Godot 4.7.2 or bpy 5.2.3 and a smoke test of its own', async () => {
    const catalog = await loadCatalog(CATALOG_DIR)
    expect(catalog.entries.length).toBeGreaterThan(0)
    const smokes = new Set(await readdir(SMOKE_DIR))
    for (const entry of catalog.entries) {
      if (entry.host === 'godot') expect(entry.verified.godot, entry.id).toBe('4.7.2')
      else expect(entry.verified.bpy, entry.id).toBe('5.2.3')
      expect(smokes.has(entry.id), `${entry.id} smoke test`).toBe(true)
      const spec = SmokeSpec.parse(JSON.parse(await readFile(join(SMOKE_DIR, entry.id, 'smoke.json'), 'utf8')))
      expect(spec.run === 'blender', `${entry.id} smoke runner`).toBe(entry.host === 'blender')
      expect(spec.expect.join('\n'), `${entry.id} smoke markers`).toContain(`SMOKE_PASS ${entry.id}`)
    }
    expect([...smokes].filter(id => catalog.get(id) === undefined), 'smoke tests without an entry').toEqual([])
  })

  it('gives the Add-ons dialog an icon for each entry that may use one, each with its notice in ICONS.md', async () => {
    const catalog = await loadCatalog(CATALOG_DIR)
    // Their own icons are trademark logos (Extra Import Hints, GdUnit4, YATI) or listing art without a license (VRM), so
    // the dialog shows a letter tile for them.
    expect(catalog.entries.filter(entry => entry.icon === undefined).map(entry => entry.id).sort())
      .toEqual(['extra-import-hints', 'gdunit4', 'vrm', 'yati'])
    const withIcons = catalog.entries.filter(entry => entry.icon !== undefined).map(entry => entry.id)
    expect(Object.keys(catalog.icons).sort()).toEqual(withIcons.sort())
    const notices = await readFile(join(CATALOG_DIR, ICON_NOTICES), 'utf8')
    for (const entry of catalog.entries) {
      const icon = entry.icon
      if (icon === undefined) continue
      if (icon.license !== 'CC0-1.0' && icon.license !== 'Unlicense') expect(icon.copyright, `${entry.id} icon copyright`).toBeDefined()
      expect(notices, `${entry.id} icon notice`).toContain(`| ${entry.title} | \`${entry.id}/${icon.file}\` | ${icon.license} | ${icon.copyright ?? '—'} | <${icon.source}> |`)
    }
  })

  it('returns each guide through the skill tool within the pruner threshold, under a name no bundled skill takes', async () => {
    const catalog = await loadCatalog(CATALOG_DIR)
    const bundled = new Set(await readdir(BUNDLED_SKILLS_DIR))
    for (const entry of catalog.entries) {
      expect(bundled.has(entry.id), `${entry.id} is a bundled skill name`).toBe(false)
      const path = join(catalog.folder(entry.id), GUIDE_FILE)
      const guide = parseGuide(await readFile(path, 'utf8'), path)
      expect(guide.description.length, `${entry.id} description`).toBeLessThanOrEqual(DESCRIPTION_LIMIT)
      const result = renderSkillContent({
        name: entry.id,
        provider: 'game-addons',
        resourceBase: { kind: 'directory', path: `${INSTALLED_CATALOG}/${entry.id}` },
        content: guide.body,
      })
      // The pruner trims only a result longer than the threshold, counted in code points.
      expect(Array.from(result).length, `${entry.id} skill tool result`).toBeLessThanOrEqual(PRUNER_THRESHOLD)
    }
  })
})
