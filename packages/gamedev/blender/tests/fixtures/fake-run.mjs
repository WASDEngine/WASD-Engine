// Stand-in for the worker script's script mode in tests: the launch runs it under Node in place of Blender. It reads
// the script that WASD_BLENDER_SCRIPT names as JSON, takes the entry of `runs` named by its first argument after `--`
// (or the whole object), writes what it received to `received.json` in the folder that WASD_OUTPUT_DIR names, and then
// prints `bytes` characters and its lines, writes files, leaves a sleeping process behind, sleeps, ends by a signal,
// or exits as the entry says. With `log`, it appends `start <first argument> <time>` and `end <first argument> <time>`
// lines to that file. Output goes through synchronous writes, so none is lost when the process exits.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, fstatSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

const plan = JSON.parse(readFileSync(process.env.WASD_BLENDER_SCRIPT ?? '', 'utf8'))
const args = process.argv.includes('--') ? process.argv.slice(process.argv.indexOf('--') + 1) : []
const step = plan.runs?.[args[0] ?? ''] ?? plan
const output = process.env.WASD_OUTPUT_DIR ?? ''
const user = process.env.BLENDER_USER_RESOURCES ?? ''
let pipe = false
try {
  pipe = fstatSync(3) !== undefined
} catch {
  // No descriptor 3: the run did not get the server's pipe.
}
if (plan.log !== undefined) appendFileSync(plan.log, `start ${args[0] ?? ''} ${String(Date.now())}\n`)
let orphan
if (step.orphan === true) {
  // The sleeping process keeps the run's output pipes open, as a process that a script left running does.
  orphan = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'] }).pid
}
writeFileSync(join(output, 'received.json'), JSON.stringify({
  args, cwd: process.cwd(), blend: process.env.WASD_BLENDER_FILE ?? null, script: process.env.WASD_BLENDER_SCRIPT, user,
  userExists: existsSync(user), pipe, orphan: orphan ?? null,
}))
if (step.bytes !== undefined) writeSync(1, 'x'.repeat(step.bytes))
for (const line of step.print ?? []) writeSync(1, `${line}\n`)
for (const line of step.printError ?? []) writeSync(2, `${line}\n`)
for (const [name, text] of Object.entries(step.files ?? {})) {
  mkdirSync(dirname(join(output, name)), { recursive: true })
  writeFileSync(join(output, name), text)
}
const finish = () => {
  if (plan.log !== undefined) appendFileSync(plan.log, `end ${args[0] ?? ''} ${String(Date.now())}\n`)
  if (step.signal !== undefined) process.kill(process.pid, step.signal)
  else process.exit(step.exit ?? 0)
}
if (step.sleepMs === undefined) finish()
else setTimeout(finish, step.sleepMs)
