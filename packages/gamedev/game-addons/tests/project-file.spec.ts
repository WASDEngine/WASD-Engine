/**
 * Enabling and disabling add-ons in `project.godot` while every other line stays as it was, and undoing an edit later
 * while keeping what others changed meanwhile.
 */
import { describe, expect, it } from 'vitest'
import { godotString, packedStrings, projectChanges, ProjectFile, revertEdit } from '../src/project-file.ts'
import { PROJECT_GODOT } from './fixtures.ts'

/** Apply an edit to a text. */
function edited(text: string, edit: (file: ProjectFile) => void): string {
  const file = new ProjectFile(text)
  edit(file)
  return file.toString()
}

/** Enable a camera add-on the way the installer does. */
function enableCamera(file: ProjectFile): void {
  file.enablePlugin('res://addons/cam/plugin.cfg')
  file.addAutoload('Cam', 'res://addons/cam/cam.gd')
  file.set('cam', 'general/smoothing', 'true')
}

describe('ProjectFile', () => {
  it('adds a plugin, an autoload, and a setting in new sections at the end, and removes them back to the original text', () => {
    const file = new ProjectFile(PROJECT_GODOT)
    expect(file.enablePlugin('res://addons/a/plugin.cfg')).toBe(true)
    expect(file.enablePlugin('res://addons/a/plugin.cfg')).toBe(false)
    file.addAutoload('Manager', 'res://addons/a/manager.gd')
    file.set('a_plugin', 'general/speed', '3')
    expect(file.toString()).toBe(`${PROJECT_GODOT}\n[editor_plugins]\n\nenabled=PackedStringArray("res://addons/a/plugin.cfg")\n\n[autoload]\n\nManager="*res://addons/a/manager.gd"\n\n[a_plugin]\n\ngeneral/speed=3\n`)
    expect(file.editorPlugins()).toEqual(['res://addons/a/plugin.cfg'])
    expect(file.autoload('Manager')).toBe('res://addons/a/manager.gd')
    expect(file.get('a_plugin', 'general/speed')).toBe('3')
    expect(file.disablePlugin('res://addons/a/plugin.cfg')).toBe(true)
    expect(file.disablePlugin('res://addons/a/plugin.cfg')).toBe(false)
    expect(file.remove('autoload', 'Manager')).toBe(true)
    expect(file.remove('a_plugin', 'general/speed')).toBe(true)
    expect(file.remove('a_plugin', 'general/speed')).toBe(false)
    expect(file.toString()).toBe(PROJECT_GODOT)
  })

  it('keeps other plugins and appends to existing sections, after values that span lines', () => {
    const text = `${PROJECT_GODOT}\n[autoload]\n\nGame="*res://game.gd"\n\n[editor_plugins]\n\nenabled=PackedStringArray("res://addons/x/plugin.cfg")\n`
    const file = new ProjectFile(text)
    file.enablePlugin('res://addons/y/plugin.cfg')
    file.addAutoload('Y', 'res://addons/y/y.gd')
    file.set('input', 'dash', '{\n"deadzone": 0.5\n}'.replaceAll('\n', ' '))
    expect(file.toString()).toContain('Game="*res://game.gd"\nY="*res://addons/y/y.gd"\n')
    expect(file.toString()).toContain('enabled=PackedStringArray("res://addons/x/plugin.cfg", "res://addons/y/plugin.cfg")')
    expect(file.toString()).toContain('"events": [Object(InputEventKey,"keycode":32)]\n}\ndash={ "deadzone": 0.5 }\n')
    expect(file.get('input', 'jump')).toBe('{\n"deadzone": 0.5,\n"events": [Object(InputEventKey,"keycode":32)]\n}')
    file.disablePlugin('res://addons/y/plugin.cfg')
    expect(file.editorPlugins()).toEqual(['res://addons/x/plugin.cfg'])
  })

  it('replaces a key\'s value in place and keeps CRLF line ends', () => {
    const file = new ProjectFile('config_version=5\r\n\r\n[a]\r\n\r\nkey=1\r\nother=2\r\n')
    file.set('a', 'key', '7')
    expect(file.toString()).toBe('config_version=5\r\n\r\n[a]\r\n\r\nkey=7\r\nother=2\r\n')
  })

  it('reads an autoload without the singleton mark and treats a section that names a value as a key, not a header', () => {
    const file = new ProjectFile('[autoload]\n\nPlain="res://plain.gd"\nOdd=[1, 2]\n\n[x]\nv="[not]"\n')
    expect(file.autoload('Plain')).toBe('res://plain.gd')
    expect(file.autoload('Odd')).toBeUndefined()
    expect(file.autoload('Missing')).toBeUndefined()
    expect(file.get('x', 'v')).toBe('"[not]"')
  })

  it('keeps a section that still holds a comment when its last key goes', () => {
    const file = new ProjectFile('[a]\n\n; keep me\nkey=1\n')
    file.remove('a', 'key')
    expect(file.toString()).toBe('[a]\n\n; keep me\n')
  })

  it('writes an empty file\'s first section without leading blank lines', () => {
    const file = new ProjectFile('')
    file.set('s', 'k', '1')
    expect(file.toString()).toBe('[s]\n\nk=1\n')
  })
})

describe('Undoing an edit', () => {
  const start = `${PROJECT_GODOT}\n[editor_plugins]\n\nenabled=PackedStringArray("res://addons/mine/plugin.cfg")\n\n[cam]\n\ngeneral/smoothing=false\n`

  it('lists the keys an edit added, changed, and removed, with both values', () => {
    const after = edited(start, (file) => {
      enableCamera(file)
      file.remove('application', 'config/name')
    })
    expect(projectChanges(start, after)).toEqual([
      { section: 'application', key: 'config/name', before: '"Test Game"', after: undefined },
      { section: 'editor_plugins', key: 'enabled', before: 'PackedStringArray("res://addons/mine/plugin.cfg")', after: 'PackedStringArray("res://addons/mine/plugin.cfg", "res://addons/cam/plugin.cfg")' },
      { section: 'cam', key: 'general/smoothing', before: 'false', after: 'true' },
      { section: 'autoload', key: 'Cam', before: undefined, after: '"*res://addons/cam/cam.gd"' },
    ])
    expect(projectChanges(start, start)).toEqual([])
    expect(new ProjectFile('a=1\n[s]\nk=2\nk=3\n').keys()).toEqual([{ section: '', key: 'a', value: '1' }, { section: 's', key: 'k', value: '2' }])
  })

  it('brings the text before the edit back byte for byte when nobody changed the file since', () => {
    const disabled = edited(edited(start, enableCamera), file => file.remove('cam', 'general/smoothing'))
    const enabled = edited(start, enableCamera)
    expect(revertEdit(enabled, start, enabled)).toBe(start)
    // The keys that a removal took out come back in their places, not at the end of the file.
    expect(revertEdit(disabled, enabled, disabled)).toBe(enabled)
  })

  it('keeps what others changed after the edit, in other keys, in the same keys, and in the plugin list', () => {
    const enabled = edited(start, enableCamera)
    const theirs = edited(enabled, (file) => {
      file.set('display', 'window/size/viewport_width', '1920')
      file.enablePlugin('res://addons/theirs/plugin.cfg')
      file.set('cam', 'general/smoothing', '"theirs"')
    })
    const reverted = new ProjectFile(revertEdit(theirs, start, enabled))
    expect(reverted.editorPlugins()).toEqual(['res://addons/mine/plugin.cfg', 'res://addons/theirs/plugin.cfg'])
    expect(reverted.autoload('Cam')).toBeUndefined()
    expect(reverted.get('cam', 'general/smoothing')).toBe('"theirs"')
    expect(reverted.get('display', 'window/size/viewport_width')).toBe('1920')
  })

  it('puts back a value that spans lines, with the file\'s CRLF line ends', () => {
    const before = 'config_version=5\r\n\r\n[importer_defaults]\r\n\r\nscene={\r\n"nodes/root_type": "Node3D"\r\n}\r\n'
    const after = edited(before, (file) => { file.set('importer_defaults', 'scene', '{"import_script/path": "res://x.gd"}') })
    expect(after).toBe('config_version=5\r\n\r\n[importer_defaults]\r\n\r\nscene={"import_script/path": "res://x.gd"}\r\n')
    const theirs = `${after}\r\n[display]\r\n\r\nwindow/vsync=false\r\n`
    expect(revertEdit(theirs, before, after)).toBe(`${before}\r\n[display]\r\n\r\nwindow/vsync=false\r\n`)
  })
})

describe('Godot literals', () => {
  it('quotes strings and reads PackedStringArray values with escapes', () => {
    expect(godotString('a "b" \\c')).toBe('"a \\"b\\" \\\\c"')
    expect(packedStrings('PackedStringArray("a", "b \\"q\\"")')).toEqual(['a', 'b "q"'])
    expect(packedStrings('["a"]')).toEqual([])
  })
})
