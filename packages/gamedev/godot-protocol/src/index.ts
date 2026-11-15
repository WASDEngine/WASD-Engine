/**
 * The `godot/record` exchange between a Godot plugin's Host and a WASD Engine window. The package root re-exports the
 * request and answer types of `./types.ts`, which also declares the event; it has no runtime values.
 */
export type { GodotVideoEncodeEvent, GodotVideoEncodeRequest, GodotVideoEncodeResult } from './types.ts'
