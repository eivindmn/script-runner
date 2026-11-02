import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  Register,
  RenderViewport,
  Timer,
  UiOpenResult,
} from 'claude-code'

import type { OutputLine, Prefs, Run, Scan, Script } from '../types'
import {
  PATHSPECS,
  PTY,
  WRAPPER,
  applyChunks,
  bareScript,
  formatDuration,
  inspectSource,
  isCandidate,
  isScriptDir,
  isSecretPrompt,
  isSkippedPath,
  pendingPrompt,
  pushLines,
  shellQuote,
  splitArgs,
} from './text'

type Engine = EngineInterface

const PANE = 'scripts'
// Files read for a description; past this only likely scripts are read.
const MAX_READ = 300
const MAX_FILES = 3000
// Runs longer than this toast when they end, in case the pane is out of sight.
const TOAST_AFTER_MS = 5000

const EMPTY_SCAN: Scan = { status: 'idle', root: '', python: 'python3' }

// Bump a shape tag when the value's fields change: a reload keeps old values.
const scripts = atom({ plugin: 'script-menu', key: 'scripts' } as const, [], { shape: 'scripts-3' })
const scan = atom({ plugin: 'script-menu', key: 'scan' } as const, EMPTY_SCAN, { shape: 'scan-2' })
const prefs = atom({ plugin: 'script-menu', key: 'prefs' } as const, { starred: [], args: {} }, { shape: 'prefs-1' })
const runs = atom({ plugin: 'script-menu', key: 'runs' } as const, {}, { shape: 'runs-1' })
const drafts = atom({ plugin: 'script-menu', key: 'drafts' } as const, {})
const selected = atom({ plugin: 'script-menu', key: 'selected' } as const, null)
const filter = atom({ plugin: 'script-menu', key: 'filter' } as const, '')
const showAll = atom({ plugin: 'script-menu', key: 'showAll' } as const, false)
const listOffset = atom({ plugin: 'script-menu', key: 'listOffset' } as const, 0)
const closedByHand = atom({ plugin: 'script-menu', key: 'closedByHand' } as const, false)

// Favourites past this many under the prompt are a `+n` that opens the pane.
const MAX_QUICK = 5
// The scrolling list never shrinks below this many rows, whatever room is left.
const MIN_WINDOW = 3

/** Where the list's window sat in the last drawing of the menu; unset in the detail view. */
type ListArea = { top: number; size: number; total: number; paneOffset: number }

let listArea: ListArea | undefined

/** A child the module is reading from now; gone with a reload, which kills it. */
type Live = {
  id: string
  dir: string
  stream: AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult>
  pending: ProcessSpawnChunk[]
  timer?: Timer
  flushing: Promise<void>
}

const live = new Map<string, Live>()

const prefsKey = (root: string) => `prefs:${root}`

function asPrefs(value: unknown): Prefs {
  const stored = (typeof value === 'object' && value !== null ? value : {}) as Partial<Prefs>
  const starred = Array.isArray(stored.starred) ? stored.starred.filter(one => typeof one === 'string') : []
  const args =
    typeof stored.args === 'object' && stored.args !== null
      ? Object.fromEntries(Object.entries(stored.args).filter(([, one]) => typeof one === 'string'))
      : {}

  return { starred, args }
}

async function savePrefs($: Engine, change: (prefs: Prefs) => Prefs): Promise<void> {
  await update($, prefs, change)
  const { root } = await read($, scan)
  if (root !== '') await $.store.set(prefsKey(root), await read($, prefs))
}

// ---- finding the scripts -------------------------------------------------

/** The login shell's PATH and tools: an app started from the Dock has a thin PATH. */
async function probeShell($: Engine): Promise<{ envPath?: string; python?: string; uv?: string }> {
  const probe = 'printf "%s\\n" "$PATH"; command -v python3 || true; command -v uv || true'
  for (const argv of [['/bin/zsh', '-lc', probe], ['/bin/sh', '-c', probe]]) {
    const ran = await $.process.run(argv, { timeoutMs: 10000 }).catch(() => undefined)
    if (ran === undefined || ran.exitCode !== 0) continue
    const [envPath, ...found] = ran.stdout.split('\n').map(line => line.trim())

    return {
      envPath: envPath || undefined,
      python: found.find(line => line.startsWith('/') && /python3$/.test(line)),
      uv: found.find(line => line.startsWith('/') && /\/uv$/.test(line)),
    }
  }

  return {}
}

const VENV_NAMES = ['.venv', 'venv', 'env', '.env']

/** The python of a virtual environment right in `dir` (relative to the root), if one is there. */
async function venvIn($: Engine, root: string, dir: string): Promise<string | undefined> {
  const base = dir === '' ? root : `${root}/${dir}`
  const entries = await $.fs.list(base).catch(() => [])
  const folders = entries.filter(entry => entry.kind === 'dir' || entry.isLink).map(entry => entry.name)
  // The usual names first; another name (`.venv-ml`, `pyenv`) counts with a pyvenv.cfg.
  const usual = VENV_NAMES.filter(name => folders.includes(name))
  const other = folders.filter(name => !VENV_NAMES.includes(name) && /env/i.test(name))
  for (const name of [...usual, ...other]) {
    const python = `${base}/${name}/bin/python`
    const isVenv =
      (await $.fs.exists(python).catch(() => false)) &&
      (usual.includes(name) || (await $.fs.exists(`${base}/${name}/pyvenv.cfg`).catch(() => false)))
    if (isVenv) return dir === '' ? `${name}/bin/python` : `${dir}/${name}/bin/python`
  }

  return undefined
}

// Per scan: a folder's answer, shared by every script beneath it.
const venvCache = new Map<string, Promise<string | undefined>>()

/** The nearest virtual environment above a script, up to the root: `pipeline/.venv` for `pipeline/tools/x.py`. */
async function venvFor($: Engine, root: string, path: string, isCached = true): Promise<string | undefined> {
  const parts = path.split('/').slice(0, -1)
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    const dir = parts.slice(0, depth).join('/')
    const key = `${root}\0${dir}`
    let found = isCached ? venvCache.get(key) : undefined
    if (found === undefined) {
      found = venvIn($, root, dir)
      if (isCached) venvCache.set(key, found)
    }
    const venv = await found
    if (venv !== undefined) return venv
  }

  return undefined
}

const PRUNE = ['.git', '.venv', 'venv', 'node_modules', '__pycache__', 'site-packages', '.tox', 'build', 'dist']

async function listCandidates($: Engine, root: string): Promise<string[]> {
  const git = await $.process
    .run(['git', 'ls-files', '-co', '--exclude-standard', '-z', '--', ...PATHSPECS], { cwd: root, timeoutMs: 20000 })
    .catch(() => undefined)
  let files: string[]
  if (git !== undefined && git.exitCode === 0) {
    files = git.stdout.split('\0')
  } else {
    const prune = PRUNE.flatMap((name, i) => (i === 0 ? ['-name', name] : ['-o', '-name', name]))
    const wanted = [
      ...['*.py', '*.sh', '*.bash', '*.zsh', '*.command'].flatMap(name => ['-o', '-name', name]),
      ...['bin', 'scripts', 'script', 'tools', 'tasks', 'cli'].flatMap(dir => ['-o', '-path', `*/${dir}/*`]),
    ].slice(1)
    const found = await $.process.run(
      ['find', '.', '(', ...prune, ')', '-prune', '-o', '-type', 'f', '(', ...wanted, ')', '-print'],
      { cwd: root, timeoutMs: 20000 },
    )
    files = found.stdout.split('\n').map(file => file.replace(/^\.\//, ''))
  }

  return [...new Set(files)]
    .filter(file => file !== '' && isCandidate(file) && !isSkippedPath(file))
    .sort()
    .slice(0, MAX_FILES)
}

/** Files with a `__main__` guard or a shebang, for repos too big to read whole. */
async function grepLikely($: Engine, root: string, files: readonly string[]): Promise<Set<string>> {
  const hits = new Set<string>()
  for (let i = 0; i < files.length; i += 400) {
    const ran = await $.process
      .run(['grep', '-lE', '__name__[[:space:]]*==[[:space:]]*.__main__.|^#!', '--', ...files.slice(i, i + 400)], {
        cwd: root,
        timeoutMs: 20000,
      })
      .catch(() => undefined)
    for (const file of ran?.stdout.split('\n') ?? []) if (file !== '') hits.add(file)
  }

  return hits
}

async function inspectFiles($: Engine, root: string, files: readonly string[]): Promise<Script[]> {
  const found: Script[] = []
  for (let i = 0; i < files.length; i += 25) {
    const batch = await Promise.all(
      files.slice(i, i + 25).map(file =>
        $.fs
          .read(`${root}/${file}`)
          .then(source => inspectSource(file, source))
          .catch(() => undefined),
      ),
    )
    for (const one of batch) if (one !== undefined) found.push(one)
  }

  return found
}

let scanning: Promise<void> | undefined

/** Scans the project; a scan asked for while one runs joins it. */
function scanProject($: Engine): Promise<void> {
  scanning ??= scanAll($).finally(() => {
    scanning = undefined
  })

  return scanning
}

async function scanAll($: Engine): Promise<void> {
  const root = await $.session.root()
  await update($, scan, (now): Scan => ({ ...now, status: 'scanning', root, message: undefined }))
  venvCache.clear()
  try {
    const [files, shell, venv, stored] = await Promise.all([
      listCandidates($, root),
      probeShell($),
      venvIn($, root, ''),
      $.store.get(prefsKey(root)),
    ])
    let list: Script[]
    if (files.length <= MAX_READ) {
      list = await inspectFiles($, root, files)
    } else {
      const hits = await grepLikely($, root, files)
      const likely = files.filter(file => hits.has(file) || isScriptDir(file) || !file.includes('/'))
      const read = await inspectFiles($, root, likely.slice(0, MAX_READ))
      const isRead = new Set(read.map(one => one.path))
      list = [...read, ...files.filter(file => !isRead.has(file)).map(bareScript)].sort((a, b) =>
        a.path.localeCompare(b.path),
      )
    }
    const withVenvs = await Promise.all(list.map(async one => ({ ...one, venv: await venvFor($, root, one.path) })))
    await update($, prefs, () => asPrefs(stored))
    await update($, scripts, () => withVenvs)
    await update($, scan, (): Scan => ({
      status: 'done',
      root,
      python: venv !== undefined ? `${root}/${venv}` : (shell.python ?? 'python3'),
      uv: shell.uv,
      envPath: shell.envPath,
    }))
  } catch (error) {
    await update($, scan, (now): Scan => ({ ...now, status: 'failed', message: String(error) }))
  }
}

/** Reads the source again when a script is opened that the scan only listed. */
async function ensureInspected($: Engine, path: string): Promise<void> {
  const list = await read($, scripts)
  const known = list.find(one => one.path === path)
  if (known === undefined || known.description !== '' || known.isLikely) return
  const { root } = await read($, scan)
  const source = await $.fs.read(`${root}/${path}`).catch(() => undefined)
  if (source === undefined) return
  const fresh = inspectSource(path, source)
  if (fresh === undefined) return
  await update($, scripts, all => all.map(one => (one.path === path ? { ...fresh, venv: known.venv } : one)))
}

// ---- running them --------------------------------------------------------

/** The words before the script's path; `isInPane` for a run whose output the pane reads. */
function interpreter(scan: Scan, script: Script, isInPane: boolean): string[] {
  if (script.kind === 'shell') return isInPane ? [scan.python, '-c', PTY, ...script.interpreter] : script.interpreter
  if (script.isUvScript && scan.uv !== undefined) return [scan.uv, 'run', '--script']
  const python = script.venv !== undefined ? `${scan.root}/${script.venv}` : scan.python

  return isInPane ? [python, '-u'] : [python]
}

/** What activating the script's virtual environment sets: its bin first on PATH. */
function venvEnv(scan: Scan, script: Script): Record<string, string> {
  if (script.venv === undefined) return scan.envPath !== undefined ? { PATH: scan.envPath } : {}
  const bin = `${scan.root}/${script.venv.slice(0, script.venv.lastIndexOf('/'))}`

  return {
    VIRTUAL_ENV: bin.slice(0, bin.lastIndexOf('/')),
    PATH: scan.envPath !== undefined ? `${bin}:${scan.envPath}` : bin,
  }
}

/** The folder of the script's virtual environment, relative to the root (`pipeline/.venv`). */
function venvDir(script: Script): string | undefined {
  return script.venv?.replace(/\/bin\/python$/, '')
}

function pythonLabel(scan: Scan): string {
  return scan.root !== '' && scan.python.startsWith(`${scan.root}/`)
    ? scan.python.slice(scan.root.length + 1)
    : scan.python.slice(scan.python.lastIndexOf('/') + 1)
}

function commandLine(scan: Scan, script: Script, argsText: string): string {
  const head =
    script.kind === 'shell'
      ? script.interpreter
          .map(word => word.slice(word.lastIndexOf('/') + 1))
          .filter(word => word !== 'env')
          .join(' ')
      : script.isUvScript && scan.uv !== undefined
        ? 'uv run --script'
        : (script.venv ?? pythonLabel(scan))

  return [head, shellQuote(script.path), argsText.trim()].filter(part => part !== '').join(' ')
}

/** The script as the scan left it, with a virtual environment made since then found too. */
async function scriptFor($: Engine, path: string): Promise<Script> {
  const script = (await read($, scripts)).find(one => one.path === path) ?? bareScript(path)
  if (script.venv !== undefined) return script
  const venv = await venvFor($, (await read($, scan)).root, path, false)

  return venv === undefined ? script : { ...script, venv }
}

async function currentArgs($: Engine, path: string): Promise<string> {
  const draft = (await read($, drafts))[`args:${path}`]

  return draft ?? (await read($, prefs)).args[path] ?? ''
}

function flush($: Engine, path: string, one: Live): Promise<void> {
  // Chained, so a timer's flush and the final one land in order.
  one.flushing = one.flushing.then(async () => {
    const chunks = one.pending.splice(0)
    if (chunks.length === 0) return
    await update($, runs, all => {
      const run = all[path]

      return run === undefined || run.id !== one.id ? all : { ...all, [path]: applyChunks(run, chunks) }
    })
  })

  return one.flushing
}

async function finish($: Engine, path: string, id: string, ended: ProcessSpawnResult | Error): Promise<void> {
  const endedAt = await $.clock.now()
  let finished: Run | undefined
  await update($, runs, all => {
    const run = all[path]
    if (run === undefined || run.id !== id) return all
    const tail: OutputLine[] = []
    if (run.partial.stdout !== '') tail.push({ stream: 'stdout', text: run.partial.stdout })
    if (run.partial.stderr !== '') tail.push({ stream: 'stderr', text: run.partial.stderr })
    if (ended instanceof Error) tail.push({ stream: 'info', text: `Kunne ikke kjøre: ${ended.message}` })
    const code = ended instanceof Error ? null : ended.code
    const status =
      run.isStopping === true || (!(ended instanceof Error) && ended.signal !== null)
        ? 'stopped'
        : code === 0
          ? 'done'
          : 'failed'
    finished = {
      ...pushLines(run, tail),
      partial: { stdout: '', stderr: '' },
      status,
      code,
      endedAt,
      isStopping: undefined,
    }

    return { ...all, [path]: finished }
  })
  if (finished === undefined) return
  // A run out of sight (started from the hint line, say) always says how it ended.
  if (endedAt - finished.startedAt > TOAST_AFTER_MS || !(await isInView($, path))) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    const said = { done: 'er ferdig', failed: `feilet (kode ${finished.code})`, stopped: 'ble stoppet', running: '' }
    $.ui.toast(`${name} ${said[finished.status]}`)
  }
}

/** Whether the pane is up and showing this script's output. */
async function isInView($: Engine, path: string): Promise<boolean> {
  if ((await read($, selected)) !== path) return false

  return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
}

async function startRun($: Engine, path: string, argsText: string, isRemembered = true): Promise<void> {
  if (live.has(path)) return
  const now = await read($, scan)
  const script = await scriptFor($, path)
  if (isRemembered) await savePrefs($, p => ({ ...p, args: { ...p.args, [path]: argsText.trim() } }))
  const startedAt = await $.clock.now()
  const id = String(startedAt)
  const run: Run = {
    id,
    path,
    argsText,
    status: 'running',
    code: null,
    startedAt,
    lines: [{ stream: 'info', text: `$ ${commandLine(now, script, argsText)}` }],
    dropped: 0,
    partial: { stdout: '', stderr: '' },
    isTerminal: script.kind === 'shell',
  }
  await update($, runs, all => ({ ...all, [path]: run }))

  let one: Live | undefined
  try {
    const made = await $.process.run(['mktemp', '-d', '-t', 'script-menu'])
    const dir = made.stdout.trim()
    if (made.exitCode !== 0 || dir === '') throw new Error(made.stderr.trim() || 'mktemp failed')
    await update($, runs, all => (all[path]?.id === id ? { ...all, [path]: { ...run, dir } } : all))
    const stream = $.process.spawn({
      argv: ['/bin/sh', '-c', WRAPPER, 'script-menu', dir, ...interpreter(now, script, true), path, ...splitArgs(argsText)],
      cwd: now.root,
      env: {
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        NO_COLOR: '1',
        TERM: 'dumb',
        // In a pty `git log` and `man` would page and wait for keys the pane cannot send.
        PAGER: 'cat',
        GIT_PAGER: 'cat',
        MANPAGER: 'cat',
        ...venvEnv(now, script),
      },
    })
    const started: Live = { id, dir, stream, pending: [], flushing: Promise.resolve() }
    one = started
    live.set(path, started)
    for await (const chunk of stream) {
      started.pending.push(chunk)
      started.timer ??= $.clock.after(80, () => {
        started.timer = undefined
        void flush($, path, started)
      })
    }
    const ended = await stream.result
    started.timer?.cancel()
    await flush($, path, started)
    await finish($, path, id, ended)
  } catch (error) {
    one?.timer?.cancel()
    if (one !== undefined) await flush($, path, one)
    await finish($, path, id, error instanceof Error ? error : new Error(String(error)))
  } finally {
    if (live.get(path) === one) live.delete(path)
  }
}

async function sendAnswer($: Engine, path: string, answer: string): Promise<void> {
  const one = live.get(path)
  if (one === undefined) return
  await update($, drafts, all => ({ ...all, [`answer:${path}`]: '' }))
  if (one.pending.length > 0) await flush($, path, one)
  await update($, runs, all => {
    const run = all[path]
    // A pty echoes the answer itself, and hides it under `read -s`.
    if (run === undefined || run.id !== one.id || run.isTerminal === true) return all
    const prompt = pendingPrompt(run)
    const shown = isSecretPrompt(prompt) ? '•'.repeat(Math.min(Math.max(answer.length, 4), 12)) : answer
    const partial = run.partial.stdout !== '' ? { ...run.partial, stdout: '' } : { ...run.partial, stderr: '' }

    return { ...all, [path]: pushLines({ ...run, partial }, [{ stream: 'stdin', prompt, text: shown }]) }
  })
  const sent = await $.process
    .run(['/bin/sh', '-c', 'printf "%s\\n" "$1" > "$2"', 'script-menu', answer, `${one.dir}/in`], { timeoutMs: 5000 })
    .catch((error: unknown) => ({ exitCode: 1, stderr: String(error) }))
  if (sent.exitCode !== 0) $.ui.toast(`Fikk ikke sendt svaret: ${sent.stderr.trim()}`)
}

async function stopRun($: Engine, path: string): Promise<void> {
  const one = live.get(path)
  if (one === undefined) return
  await update($, runs, all => (all[path]?.id === one.id ? { ...all, [path]: { ...all[path], isStopping: true } } : all))
  const pid = (await $.fs.read(`${one.dir}/pid`).catch(() => '')).trim()
  const hasPid = /^\d+$/.test(pid)
  if (hasPid) await $.process.run(['kill', '-TERM', pid]).catch(() => undefined)
  else void one.stream.return({ code: null, signal: 'SIGTERM' })
  // A script that ignores SIGTERM is killed outright after a while.
  $.clock.after(3000, () => {
    if (live.get(path) !== one) return
    if (hasPid) void $.process.run(['kill', '-KILL', pid]).catch(() => undefined)
    void one.stream.return({ code: null, signal: 'SIGKILL' })
  })
}

async function openInTerminal($: Engine, path: string): Promise<void> {
  const now = await read($, scan)
  const script = await scriptFor($, path)
  const argsText = (await currentArgs($, path)).trim()
  const env = venvEnv(now, script)
  // Activated as `source .venv/bin/activate` would, keeping the Terminal's own PATH after it.
  const activate =
    env.VIRTUAL_ENV !== undefined ? `VIRTUAL_ENV=${shellQuote(env.VIRTUAL_ENV)} PATH=${shellQuote(`${env.VIRTUAL_ENV}/bin`)}:"$PATH"` : ''
  const line = [
    `cd ${shellQuote(now.root)}`,
    '&&',
    activate,
    ...interpreter(now, script, false).map(shellQuote),
    shellQuote(path),
    argsText,
  ]
    .filter(part => part !== '')
    .join(' ')
  const quoted = line.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const ran = await $.process
    .run(['osascript', '-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script "${quoted}"`, '-e', 'end tell'], {
      timeoutMs: 15000,
    })
    .catch((error: unknown) => ({ exitCode: 1, stderr: String(error) }))
  if (ran.exitCode !== 0) $.ui.toast(`Kunne ikke åpne Terminal: ${ran.stderr.trim()}`)
}

async function askClaude($: Engine, path: string): Promise<void> {
  const run = (await read($, runs))[path]
  if (run === undefined) return
  const tail = run.lines
    .slice(-60)
    .map(line => (line.stream === 'stdin' ? `${line.prompt ?? ''}${line.text}` : line.text))
    .join('\n')
  const text =
    `Scriptet \`${path}\` feilet (kode ${run.code ?? '?'}). Slutten av utdataene:\n\n` +
    '```\n' +
    tail +
    '\n```\n\nHva gikk galt, og hvordan fikser jeg det?'
  await $.prompt.fill({ text, mode: 'replace' })
}

async function select($: Engine, path: string | null): Promise<void> {
  await update($, selected, () => path)
  if (path !== null) await ensureInspected($, path)
}

/** Moves the list's window by `by` rows, kept inside the list. */
async function moveList($: Engine, by: number): Promise<void> {
  const area = listArea
  if (area === undefined) return
  const last = Math.max(0, area.total - area.size)
  await update($, listOffset, offset => Math.max(0, Math.min(last, Math.min(offset, last) + by)))
}

/** Opens the pane and scans when the project has not been scanned yet. */
async function showPane($: Engine): Promise<UiOpenResult> {
  const [root, now] = await Promise.all([$.session.root(), read($, scan)])
  const opened = await $.ui.open({ id: PANE, title: 'Scripts' })
  if (now.status === 'idle' || now.status === 'failed' || now.root !== root) void scanProject($)

  return opened
}

/**
 * Opens the pane unasked where the surface docks it beside the transcript, so
 * the scripts are always at hand; never once the person has closed it.
 */
async function openBeside($: Engine, surface: string, viewport?: RenderViewport): Promise<void> {
  if (surface === 'terminal' || surface === 'mobile' || viewport?.isFullscreen === false) return
  if (await read($, closedByHand)) return
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) return
  await showPane($)
}

/**
 * A favourite's button under the prompt: runs it out of sight with its last
 * arguments. One that is running, asks for input or needs a terminal is shown
 * where that can happen instead: the pane, or Terminal.
 */
async function quickRun($: Engine, path: string): Promise<void> {
  const script = await scriptFor($, path)
  if (script.needsTerminal) return openInTerminal($, path)
  const isRunning = (await read($, runs))[path]?.status === 'running'
  if (isRunning || script.asksInput || script.asksSecret) {
    await select($, path)
    await openPane($)
  }
  if (!isRunning) void startRun($, path, await currentArgs($, path))
}

/** Shows the pane on the person's word, whatever closed it before. */
async function openPane($: Engine): Promise<void> {
  await update($, closedByHand, () => false)
  const opened = await showPane($)
  if (!opened.isPlaced) $.ui.toast(`Script-panelet fikk ikke plass ennå: ${opened.reason}`)
}

/** The hint line's button: shows the pane, or closes it while it is up. */
async function togglePane($: Engine): Promise<void> {
  if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
    await update($, closedByHand, () => true)
    await $.ui.close({ id: PANE })

    return
  }
  await openPane($)
}

// ---- the hooks -----------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'scripts',
      description: 'Vis script-panelet: kjør Python- og shell-scriptene i prosjektet',
      argumentHint: '[søk]',
    })
    // A reload killed whatever the previous copy of the module was running.
    await update($, runs, all => {
      const stale = Object.values(all).filter(run => run.status === 'running' && !live.has(run.path))
      if (stale.length === 0) return all
      const fixed = { ...all }
      for (const run of stale) {
        fixed[run.path] = {
          ...pushLines(run, [{ stream: 'info', text: 'Avbrutt: moden ble lastet på nytt.' }]),
          status: 'stopped',
          isStopping: undefined,
        }
      }

      return fixed
    })
    const result = await next(e)
    // A surface that attached before the module loaded raises no attach of its own.
    for (const surface of await $.session.surfaces()) void openBeside($, surface)

    return result
  })

  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    void openBeside($, e.surface, e.viewport)

    return result
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') await update($, closedByHand, () => true)

    return next(e)
  })

  // The wheel over the list moves the list, under favourites that stay put.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const area = listArea
    if (area === undefined || area.total <= area.size) return next(e)
    const row = e.pointer === undefined ? undefined : e.pointer.row + area.paneOffset
    const isOverList =
      row === undefined ? e.contentRows <= e.bodyRows : row >= area.top && row <= area.top + area.size
    if (!isOverList) return next(e)
    await moveList($, e.by)

    return {}
  })

  on('command.run', { command: 'scripts' }, async ($, e) => {
    const query = e.args.trim()
    const root = await $.session.root()
    const now = await read($, scan)
    const isStale = now.status === 'idle' || now.status === 'failed' || now.root !== root
    await update($, filter, () => query)
    await update($, listOffset, () => 0)
    await update($, closedByHand, () => false)
    if (query !== '' && !isStale) {
      const q = query.toLowerCase()
      const matches = (await read($, scripts)).filter(one => one.path.toLowerCase().includes(q))
      await select($, matches.length === 1 ? (matches[0]?.path ?? null) : null)
    } else if (query !== '') {
      await select($, null)
    }
    const opened = await showPane($)

    return opened.isPlaced ? {} : { text: `Script-panelet fikk ikke plass ennå: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const [now, list, saved, all, chosen, query, isAll, draft, offset] = await Promise.all([
      read($, scan),
      read($, scripts),
      read($, prefs),
      read($, runs),
      read($, selected),
      read($, filter),
      read($, showAll),
      read($, drafts),
      read($, listOffset),
    ])
    const starred = new Set(saved.starred)

    const star = (path: string, key: string) => (
      <Button
        key={key}
        plain
        label={starred.has(path) ? '★' : '☆'}
        onPress={() =>
          savePrefs($, p => ({
            ...p,
            starred: p.starred.includes(path) ? p.starred.filter(one => one !== path) : [...p.starred, path],
          }))
        }
      />
    )

    const mark = (run: Run | undefined) => {
      if (run === undefined) return null
      if (run.status === 'running') {
        return <Text color="warning">{pendingPrompt(run) !== '' ? '● venter på svar' : '● kjører'}</Text>
      }
      if (run.status === 'done') return <Text color="success">✓</Text>
      if (run.status === 'failed') return <Text color="error">✗ {String(run.code ?? '')}</Text>

      return <Text dimColor>■</Text>
    }

    // ---- one script, its arguments and its output
    if (chosen !== null) {
      listArea = undefined
      const script = list.find(one => one.path === chosen) ?? bareScript(chosen)
      const path = script.path
      const run = all[path]
      const isRunning = run?.status === 'running'
      const argsValue = draft[`args:${path}`] ?? saved.args[path] ?? ''
      const prompt = run === undefined ? '' : pendingPrompt(run)
      const ended = run?.endedAt !== undefined ? formatDuration(run.endedAt - run.startedAt) : ''
      const heading =
        run === undefined
          ? null
          : run.status === 'running'
            ? <Text bold color="warning">{run.isStopping === true ? '● Stopper…' : prompt !== '' ? '● Venter på svar' : '● Kjører…'}</Text>
            : run.status === 'done'
              ? <Text bold color="success">✓ Ferdig · {ended}</Text>
              : run.status === 'failed'
                ? <Text bold color="error">✗ Feilet{run.code === null ? '' : ` med kode ${run.code}`} · {ended}</Text>
                : <Text bold dimColor>■ Stoppet · {ended}</Text>

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key="back" plain dimColor label="← Alle scripts" onPress={() => select($, null)} />
          </Box>
          <Box flexDirection="row" gap={1} marginTop={1}>
            {star(path, 'star')}
            <Text bold>{script.name}</Text>
          </Box>
          <Text dimColor wrap="truncate-middle">{path}</Text>
          {script.description !== '' && <Text>{script.description}</Text>}
          {script.venv !== undefined ? (
            <Text dimColor wrap="truncate-middle">Miljø: {venvDir(script) ?? ''}</Text>
          ) : (
            script.kind === 'python' && !script.isUvScript && <Text dimColor>Python: {pythonLabel(now)} (fant ingen .venv)</Text>
          )}
          {script.needsTerminal && (
            <Text color="warning">Bruker en terminalmeny som panelet ikke kan vise. Velg «Åpne i Terminal».</Text>
          )}
          {!script.needsTerminal && (script.asksInput || script.asksSecret) && (
            <Text dimColor>Spør om input underveis: svar i feltet under utdataene.</Text>
          )}
          <Box flexDirection="column" marginTop={1}>
            {Input !== undefined ? (
              <Input
                key="args"
                label="Argumenter "
                placeholder={script.hasHelp ? 'f.eks. --help' : 'ingen'}
                value={argsValue}
                submitLabel="kjør"
                onInput={value => update($, drafts, d => ({ ...d, [`args:${path}`]: value }))}
                onSubmit={value => {
                  if (!live.has(path)) void startRun($, path, value)
                }}
              />
            ) : (
              argsValue !== '' && <Text dimColor>Argumenter: {argsValue}</Text>
            )}
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {isRunning ? (
              <Button key="stop" label="■ Stopp" onPress={() => stopRun($, path)} />
            ) : (
              <Button
                key="run"
                variant="primary"
                label="▶ Kjør"
                onPress={async () => {
                  void startRun($, path, await currentArgs($, path))
                }}
              />
            )}
            {!isRunning && script.hasHelp && (
              <Button key="help" label="--help" onPress={() => void startRun($, path, '--help', false)} />
            )}
            <Button key="terminal" label="Åpne i Terminal" onPress={() => openInTerminal($, path)} />
          </Box>
          {run !== undefined && (
            <Box flexDirection="column" marginTop={1}>
              {heading}
              {run.dropped > 0 && <Text dimColor>… {String(run.dropped)} eldre linjer skjult</Text>}
              {run.lines.map(line =>
                line.stream === 'stdin' ? (
                  <Box flexDirection="row">
                    <Text>{line.prompt ?? ''}</Text>
                    <Text bold color="suggestion">{line.text}</Text>
                  </Box>
                ) : line.stream === 'info' ? (
                  <Text dimColor>{line.text}</Text>
                ) : (
                  <Text color={line.stream === 'stderr' ? 'warning' : undefined}>{line.text === '' ? ' ' : line.text}</Text>
                ),
              )}
              {isRunning && run.partial.stderr !== '' && <Text color="warning">{run.partial.stderr}</Text>}
              {isRunning && run.partial.stdout !== '' && <Text>{run.partial.stdout}</Text>}
              {isRunning && Input !== undefined && (
                <Input
                  key="answer"
                  label={prompt !== '' ? 'Svar ' : 'Til scriptet '}
                  placeholder={prompt !== '' ? 'skriv og trykk Enter' : 'tekst sendes som en linje på stdin'}
                  value={draft[`answer:${path}`] ?? ''}
                  submitLabel="send"
                  autoFocus
                  onInput={value => update($, drafts, d => ({ ...d, [`answer:${path}`]: value }))}
                  onSubmit={value => sendAnswer($, path, value)}
                />
              )}
              {!isRunning && (
                <Box flexDirection="row" gap={1} marginTop={1}>
                  <Button
                    key="clear"
                    plain
                    dimColor
                    label="Tøm utdata"
                    onPress={() =>
                      update($, runs, every => {
                        const rest = { ...every }
                        delete rest[path]

                        return rest
                      })
                    }
                  />
                  {run.status === 'failed' && (
                    <Button key="ask" plain dimColor label="Spør Claude om feilen" onPress={() => askClaude($, path)} />
                  )}
                </Box>
              )}
            </Box>
          )}
        </Box>
      )
    }

    // ---- the menu
    const q = query.trim().toLowerCase()
    const shown = list
      .filter(one => isAll || one.isLikely || starred.has(one.path))
      .filter(one => q === '' || one.path.toLowerCase().includes(q) || one.description.toLowerCase().includes(q))
    const favourites = shown.filter(one => starred.has(one.path)).sort((a, b) => a.name.localeCompare(b.name))
    const others = shown.filter(one => !starred.has(one.path))
    const likelyCount = list.filter(one => one.isLikely).length
    const hasSearch = Input !== undefined && list.length > 8
    const hasShowAll = now.status === 'done' && list.length > likelyCount
    const isEmpty = now.status === 'done' && shown.length === 0

    // The favourites stay put and the rest scroll in a window under them. Each
    // script is one row, so the rows around the window are counted (a margin a
    // row) and the window fills what is left of the pane.
    const above =
      1 +
      (now.root !== '' ? 1 : 0) +
      (now.status === 'scanning' || now.status === 'failed' ? 1 : 0) +
      (hasSearch ? 2 : 0) +
      (favourites.length > 0 ? 2 + favourites.length : 0) +
      (others.length > 0 ? (favourites.length > 0 ? 2 : 1) : 0)
    const below = (hasShowAll ? 2 : 0) + (isEmpty ? 2 : 0)
    const room = e.props.scroll.bodyRows - above - below
    // A window short of the whole list gives a row to its ▲ ▼ line.
    const size = others.length <= room ? others.length : Math.max(MIN_WINDOW, room - 1)
    const first = Math.max(0, Math.min(offset, others.length - size))
    const visible = others.slice(first, first + size)
    listArea = { top: above, size, total: others.length, paneOffset: e.props.scroll.offset }

    const row = (script: Script) => (
      <Box key={`row:${script.path}`} flexDirection="row" gap={1}>
        {star(script.path, `star:${script.path}`)}
        <Button
          key={`run:${script.path}`}
          plain
          label={live.has(script.path) ? '■' : '▶'}
          onPress={async () => {
            await select($, script.path)
            if (live.has(script.path)) await stopRun($, script.path)
            else void startRun($, script.path, await currentArgs($, script.path))
          }}
        />
        <Button key={`open:${script.path}`} plain label={script.name} onPress={() => select($, script.path)} />
        {mark(all[script.path])}
        <Text dimColor wrap="truncate-end">
          {[script.dir === '' ? '' : `${script.dir}/`, script.description].filter(part => part !== '').join(' · ')}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>Scripts</Text>
          <Button key="rescan" plain dimColor label="↻ Oppdater" onPress={() => scanProject($)} />
        </Box>
        {now.root !== '' && (
          <Text dimColor wrap="truncate-start">
            {now.root.slice(now.root.lastIndexOf('/') + 1)} · {pythonLabel(now)}
          </Text>
        )}
        {now.status === 'scanning' && <Text dimColor>Leter etter scripts…</Text>}
        {now.status === 'failed' && <Text color="error">Skanningen feilet: {now.message ?? ''}</Text>}
        {hasSearch && Input !== undefined && (
          <Box marginTop={1}>
            <Input
              key="filter"
              label="Søk "
              placeholder="navn, mappe eller beskrivelse"
              value={query}
              onInput={async value => {
                await update($, filter, () => value)
                await update($, listOffset, () => 0)
              }}
              onSubmit={value => update($, filter, () => value)}
            />
          </Box>
        )}
        {favourites.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="claude">★ Favoritter</Text>
            {favourites.map(row)}
          </Box>
        )}
        {others.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {favourites.length > 0 && <Text bold>Alle scripts</Text>}
            {visible.map(row)}
            {size < others.length && (
              <Box flexDirection="row" gap={1}>
                <Button key="list-up" plain dimColor label="▲" onPress={() => moveList($, -size)} />
                <Button key="list-down" plain dimColor label="▼" onPress={() => moveList($, size)} />
                <Text dimColor>{`${first + 1}–${first + visible.length} av ${others.length}`}</Text>
              </Box>
            )}
          </Box>
        )}
        {isEmpty && (
          <Box marginTop={1}>
            <Text dimColor>
              {q !== '' ? `Ingen treff på «${query.trim()}».` : 'Fant ingen scripts her.'}
            </Text>
          </Box>
        )}
        {hasShowAll && (
          <Box marginTop={1}>
            <Button
              key="show-all"
              plain
              dimColor
              label={isAll ? 'Vis bare kjørbare scripts' : `Vis alle filer (${list.length})`}
              onPress={async () => {
                await update($, showAll, value => !value)
                await update($, listOffset, () => 0)
              }}
            />
          </Box>
        )}
      </Box>
    )
  })

  // The hint line under the prompt: a button for the pane, then one per
  // favourite that runs it, the engine's own line kept after them.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const own = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const [now, list, saved, all] = await Promise.all([read($, scan), read($, scripts), read($, prefs), read($, runs)])
    // The favourites come with the scan: the line's first drawing starts one.
    if (now.status === 'idle') void scanProject($)
    const running = Object.values(all).filter(run => run.status === 'running')
    const isWaiting = running.some(run => pendingPrompt(run) !== '')
    const favourites = list
      .filter(one => saved.starred.includes(one.path))
      .sort((a, b) => a.name.localeCompare(b.name))
    const shown = favourites.slice(0, MAX_QUICK)

    const quick = (script: Script) => {
      const status = all[script.path]?.status
      const mark = status === 'running' ? '●' : status === 'done' ? '✓' : status === 'failed' ? '✗' : '▶'

      return (
        <Button
          key={`quick:${script.path}`}
          plain
          dimColor={status === undefined || status === 'stopped'}
          label={`${mark} ${script.name}`}
          onPress={() => quickRun($, script.path)}
        />
      )
    }

    return (
      <Box flexDirection="row" gap={1}>
        <Button key="scripts-toggle" plain dimColor label="☰ Scripts" onPress={() => togglePane($)} />
        {running.length > 0 && (
          <Text color="warning">{isWaiting ? 'venter på svar' : `${running.length} kjører`}</Text>
        )}
        {shown.map(quick)}
        {favourites.length > shown.length && (
          <Button
            key="scripts-more"
            plain
            dimColor
            label={`+${favourites.length - shown.length}`}
            onPress={async () => {
              await select($, null)
              await openPane($)
            }}
          />
        )}
        {own}
      </Box>
    )
  })
}
