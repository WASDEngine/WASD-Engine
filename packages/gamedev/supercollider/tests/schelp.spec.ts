/** Help file text for the agent: header tags, sections, methods and arguments, inline markup, lists, code blocks, and the size bound. */
import { describe, expect, it } from 'vitest'
import { condenseHelp, helpSummary } from '../src/schelp.ts'

const HELP = [
  'class:: SinOsc',
  'summary:: Interpolating sine code::wavetable:: oscillator.',
  'related:: Classes/Osc, Classes/FSinOsc, Reference/Glossary#Wavetable, Classes/Env#*perc, Classes/Pbind#Patterns#the Pbind guide',
  'categories::  UGens>Generators',
  'keyword:: sine',
  '',
  'Description::',
  'Generates a sine wave, like link::Classes/Osc:: and link::#-mod:: with emphasis::care::.',
  'note::Keep phase within strong::+-8pi::.::',
  'warning::',
  'Inline warnings span lines.',
  '::',
  '',
  'subsection:: Related oscillators',
  'LIST::',
  '## link::Classes/FSinOsc:: – fast',
  '## Klang || bank',
  '::',
  'footnote::See the guide.::',
  'private:: initClass',
  '',
  'classmethods::',
  'method:: ar, kr',
  'argument:: freq',
  'Frequency in Hertz.',
  'returns:: A UGen.',
  'discussion:: Rates differ.',
  '',
  'instancemethods::',
  'copymethod:: UGen -range',
  'teletype::raw text::',
  'section:: Notes',
  'title:: Other',
  'Examples::',
  'code::',
  '{ SinOsc.ar(200) }.play;',
  '::',
  'code:: SinOsc.ar ::',
].join('\r\n')

describe('helpSummary', () => {
  it('returns the summary without markup', () => {
    expect(helpSummary(HELP)).toBe('Interpolating sine wavetable oscillator.')
    expect(helpSummary('class:: Foo\nsummary::\n')).toBeUndefined()
    expect(helpSummary('class:: Foo')).toBeUndefined()
  })
})

describe('condenseHelp', () => {
  it('turns tags into labeled lines and headings and keeps code blocks', () => {
    expect(condenseHelp(HELP, 10_000)).toBe([
      'SinOsc',
      'Summary: Interpolating sine wavetable oscillator.',
      'Related: Osc, FSinOsc, Glossary.Wavetable, Env.perc, the Pbind guide',
      'Categories: UGens>Generators',
      '',
      '',
      'Description:',
      'Generates a sine wave, like Osc and mod with care.',
      'Note: Keep phase within +-8pi.',
      'Note: ',
      'Inline warnings span lines.',
      '',
      '',
      '',
      'Related oscillators:',
      '',
      '- FSinOsc – fast',
      '- Klang  |  bank',
      '',
      '(See the guide.)',
      '',
      '',
      'Class methods:',
      '',
      'ar, kr',
      '  freq:',
      'Frequency in Hertz.',
      '  Returns: A UGen.',
      '  Discussion: Rates differ.',
      '',
      '',
      'Instance methods:',
      'raw text',
      '',
      'Notes:',
      'Other',
      '',
      'Examples:',
      '  { SinOsc.ar(200) }.play;',
      ' SinOsc.ar',
    ].join('\n').replace(/\n{3,}/gu, '\n\n'))
  })

  it('cuts long text and counts what it cut', () => {
    const long = `class:: Long\n\n${'word '.repeat(400)}`
    const text = condenseHelp(long, 200)
    expect(text.length).toBeLessThanOrEqual(200)
    expect(text).toMatch(/\n\[help truncated: \d+ more characters\]$/u)
  })
})
