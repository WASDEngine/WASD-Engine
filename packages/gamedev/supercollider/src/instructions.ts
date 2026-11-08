/** Model-facing identity of the SuperCollider MCP server: its name and the instructions that the client adds to the agent's context. */

/**
 * Name of the SuperCollider MCP server: the MCP manager key, the tool namespace (`mcp__wasd_supercollider__<tool>`), and
 * the heading of the instructions in the system prompt. The `wasd_` prefix keeps it apart from a `supercollider` server
 * that a user configures.
 */
export const SUPERCOLLIDER_SERVER_NAME = 'wasd_supercollider'

/** How to use the SuperCollider tools, at most 6000 characters. */
export const SUPERCOLLIDER_INSTRUCTIONS = `SuperCollider runs headless behind these tools: sclang, its language, keeps state between calls, and scsynth renders sound offline into files. There is no audio device, so nothing plays aloud and real-time servers cannot boot: judge a sound by the measurements and the waveform and spectrogram image that render_audio and analyze_audio return. SuperCollider keeps one interpreter for each conversation: environment variables such as ~kick and SynthDefs added with .add persist between calls until SuperCollider restarts after a crash or a timeout, or stops after a long pause in the calls. The first result after a start names the version.

Paths are absolute. Resolve relative names against your working directory. Write game audio inside the game project; for Godot, use a folder under the directory that contains project.godot so the files are reachable as res:// paths.

Make, look, adjust:
- render_audio evaluates code and renders its value for exactly duration seconds: a UGen graph function such as { Pan2.ar(SinOsc.ar(440), 0) * Env.perc(0.01, 0.5).kr(2) }, a SynthDef, a pattern such as Pbind, or a Score. A function's output channels set the file's channels unless channels is given. Patterns play SynthDefs added with .add, or \\default. Sound that is still playing at the end is cut off.
- Read its report: peak and RMS levels, loudness in LUFS, clipping, silence at the start and end, and the dominant frequency. Look at the image: the waveform of each channel above, the spectrogram below. Fix clipping, unintended silence, clicks (thin vertical lines in the spectrogram at onsets or at the end), and harsh highs before calling a sound done.
- analyze_audio reports on any audio file the same way, optionally on a time window.
- execute_sclang runs code to define SynthDefs, build patterns and data, and inspect state. Its result is the value of the last expression as code, and posted text (postln) returns as output. The code runs in a Routine, so .wait works.
- class_info shows classes with their methods, argument names, and defaults, and their help text; check UGen arguments there instead of guessing. Its search finds classes by name.

Game audio:
- Short effects: mono .wav at 44100 Hz with int16 samples, a peak near -1 dBFS (normalize_db: -1), no silence before the onset, and an envelope that ends at zero within the duration, such as Env.perc(...).kr(2).
- Music and ambience: stereo .ogg (Vorbis). For a loop, render a duration of whole bars at the tempo and make the end flow into the start: let releases and effect tails wrap or finish before the end. Godot imports .wav and .ogg; loop playback is an import setting.
- Keep related sounds at a consistent loudness: compare LUFS, not peaks.
- Keep the SuperCollider source next to the sound, such as sfx/jump.scd beside sfx/jump.wav, so it can be changed and rendered again.`
