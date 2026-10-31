import type { OutputLine, Run, Script } from '../types'

export const MAX_LINES = 500
const MAX_LINE_CHARS = 2000

const SKIP_DIRS = new Set([
  '.git', '.hg', '.venv', 'venv', 'env', '.env', 'virtualenv', 'node_modules',
  '__pycache__', 'site-packages', '.tox', '.nox', 'build', 'dist', '.eggs',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.idea', '.vscode',
])
const SKIP_FILE = /^(__init__|conftest|setup|noxfile|_version)\.py$|^test_.*\.py$|_test\.py$/
const SCRIPT_DIR = /(^|\/)(scripts?|tools?|bin|tasks|cli|commands|jobs)\//i

/** Folders and files a script menu never offers: environments, caches, tests. */
export function isSkippedPath(path: string): boolean {
  const parts = path.split('/')
  const name = parts[parts.length - 1] ?? ''
  if (SKIP_FILE.test(name)) return true
  if (parts.some(part => part === 'tests' || part === 'test' || part === 'migrations')) return true

  return parts.slice(0, -1).some(part => SKIP_DIRS.has(part) || part.endsWith('.egg-info'))
}

export function isScriptDir(path: string): boolean {
  return SCRIPT_DIR.test(path)
}

const SHELL_SUFFIX = /\.(sh|bash|zsh|command)$/

/** Python and shell files by suffix, and suffixless files in a scripts folder (`bin/setup`). */
export function isCandidate(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (name.endsWith('.py') || SHELL_SUFFIX.test(name)) return true

  return !name.includes('.') && isScriptDir(path)
}

/** What `git ls-files` is asked for: every candidate, with no other file listed. */
export const PATHSPECS = [
  '*.py', '*.sh', '*.bash', '*.zsh', '*.command',
  ...['bin', 'scripts', 'script', 'tools', 'tool', 'tasks', 'cli', 'commands', 'jobs'].flatMap(dir => [
    `${dir}/*`,
    `*/${dir}/*`,
  ]),
]

const MAIN_GUARD = /__name__\s*==\s*['"]__main__['"]/
const ASKS_INPUT = /(^|[^\w.])input\s*\(|\b(click|typer)\.(prompt|confirm)\s*\(|\b(Prompt|Confirm|IntPrompt|FloatPrompt)\.ask\s*\(/
const ASKS_SECRET = /\bgetpass\b/
const NEEDS_TERMINAL =
  /^\s*(import|from)\s+(curses|questionary|inquirer|InquirerPy|prompt_toolkit|simple_term_menu|pick|textual|urwid|blessed)\b|\btermios\b|\btty\.setraw\b/m
const HAS_HELP = /\bargparse\b|ArgumentParser|^\s*(import|from)\s+(click|typer|docopt|fire)\b/m
const UV_SCRIPT = /^# \/\/\/ script\s*$/m

// `read` where a command starts; a hint only, so `while read line < file` may count too.
const SHELL_READ = String.raw`(^|[;&|({]|\b(then|do|while|until|if|else))\s*read(?=\s|$)`
const SHELL_ASKS_INPUT = new RegExp(`${SHELL_READ}|(^|\\s)select\\s+\\w+\\s+in\\b|\\bvared\\b`, 'm')
const SHELL_ASKS_SECRET = new RegExp(`${SHELL_READ}[^\\n;]*\\s-[a-zA-Z]*s[a-zA-Z]*\\b`, 'm')
const SHELL_NEEDS_TERMINAL = /(^|[\s;|&($])(dialog|whiptail|fzf|gum|vipe)\b/m
const SHELL_HAS_HELP = /--help|\bgetopts\b|\busage\s*\(\)|^\s*usage\s*\{|function\s+usage\b/m

/** The interpreter a shebang names, as words: `#!/usr/bin/env bash` is `['/usr/bin/env', 'bash']`. */
function shebangOf(source: string): string[] {
  const first = source.replace(/^﻿/, '').split('\n', 1)[0] ?? ''

  return first.startsWith('#!') ? first.slice(2).trim().split(/\s+/).filter(word => word !== '') : []
}

function shellFor(name: string): string[] {
  return name.endsWith('.zsh') ? ['/bin/zsh'] : ['/bin/bash']
}

/** What the menu shows and needs to know about one file, from its source; undefined when no script. */
export function inspectSource(path: string, source: string): Script | undefined {
  const slash = path.lastIndexOf('/')
  const name = path.slice(slash + 1)
  const shebang = shebangOf(source)
  const isPython = name.endsWith('.py') || shebang.some(word => /python/.test(word))
  const base = { path, name, dir: slash < 0 ? '' : path.slice(0, slash), description: describe(source) }

  if (isPython) {
    return {
      ...base,
      kind: 'python',
      interpreter: [],
      isLikely: MAIN_GUARD.test(source) || shebang.length > 0 || isScriptDir(path),
      asksInput: ASKS_INPUT.test(source),
      asksSecret: ASKS_SECRET.test(source),
      needsTerminal: NEEDS_TERMINAL.test(source),
      hasHelp: HAS_HELP.test(source),
      isUvScript: UV_SCRIPT.test(source),
    }
  }
  // A suffixless file is a script only by its shebang.
  if (!SHELL_SUFFIX.test(name) && shebang.length === 0) return undefined

  return {
    ...base,
    kind: 'shell',
    interpreter: shebang.length > 0 ? shebang : shellFor(name),
    isLikely: shebang.length > 0 || isScriptDir(path) || slash < 0,
    asksInput: SHELL_ASKS_INPUT.test(source),
    asksSecret: SHELL_ASKS_SECRET.test(source),
    needsTerminal: SHELL_NEEDS_TERMINAL.test(source),
    hasHelp: SHELL_HAS_HELP.test(source),
    isUvScript: false,
  }
}

/** A bare entry for a file the scan did not read. */
export function bareScript(path: string): Script {
  const slash = path.lastIndexOf('/')
  const name = path.slice(slash + 1)
  const isPython = name.endsWith('.py')

  return {
    path,
    name,
    dir: slash < 0 ? '' : path.slice(0, slash),
    kind: isPython ? 'python' : 'shell',
    interpreter: isPython ? [] : shellFor(name),
    description: '',
    isLikely: isScriptDir(path),
    asksInput: false,
    asksSecret: false,
    needsTerminal: false,
    hasHelp: false,
    isUvScript: false,
  }
}

function firstLine(text: string): string {
  const line = text.split('\n').map(one => one.trim()).find(one => one !== '') ?? ''

  return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

/** The module docstring's first line, else the leading comment, else argparse's description. */
export function describe(source: string): string {
  const head = source.replace(/^﻿/, '')
  const doc = /^(?:\s*#[^\n]*\n|\s*\n)*\s*[rRuU]?("""|''')([\s\S]*?)\1/.exec(head)
  if (doc !== null && firstLine(doc[2] ?? '') !== '') return firstLine(doc[2] ?? '')

  const comments: string[] = []
  for (const line of head.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') {
      if (comments.length > 0) break
      continue
    }
    if (!trimmed.startsWith('#')) break
    if (/^#!|coding[:=]|^#\s*(noqa|type:|pylint|ruff|fmt|shellcheck|\/\/\/|requires-python|dependencies|\]|")/.test(trimmed)) continue
    const text = trimmed.replace(/^#+\s?/, '')
    if (text !== '' && !/^[-=#*~]+$/.test(text)) comments.push(text)
  }
  if (comments.length > 0) return firstLine(comments.join(' '))

  const parser = /ArgumentParser\s*\([^)]*?description\s*=\s*[rf]?(['"])(.*?)\1/s.exec(head)

  return parser === null ? '' : firstLine(parser[2] ?? '')
}

/** Splits an argument line as a shell would: quotes group, a backslash escapes. */
export function splitArgs(text: string): string[] {
  const args: string[] = []
  let current = ''
  let hasToken = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? ''
    if (quote !== null) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && i + 1 < text.length) current += text[++i]
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      hasToken = true
    } else if (char === '\\' && i + 1 < text.length) {
      current += text[++i]
      hasToken = true
    } else if (/\s/.test(char)) {
      if (hasToken) args.push(current)
      current = ''
      hasToken = false
    } else {
      current += char
      hasToken = true
    }
  }
  if (hasToken) args.push(current)

  return args
}

export function shellQuote(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`
}

// CSI and OSC sequences, and the lone escapes a dumb terminal still gets.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** What a line with carriage returns shows last, as a terminal would (progress bars). */
function settle(text: string): string {
  if (!text.includes('\r')) return text
  const parts = text.split('\r').filter(part => part !== '')

  return parts[parts.length - 1] ?? ''
}

function clip(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text
}

export function pushLines(run: Run, lines: readonly OutputLine[]): Run {
  const all = [...run.lines, ...lines]
  const over = Math.max(0, all.length - MAX_LINES)

  return { ...run, lines: over > 0 ? all.slice(over) : all, dropped: run.dropped + over }
}

/** Folds pieces of output into whole lines, keeping the unfinished tail per stream. */
export function applyChunks(
  run: Run,
  chunks: readonly { stream: 'stdout' | 'stderr'; text: string }[],
): Run {
  const partial = { ...run.partial }
  const lines: OutputLine[] = []
  for (const chunk of chunks) {
    const text = (partial[chunk.stream] + stripAnsi(chunk.text)).replace(/\r\n/g, '\n')
    const pieces = text.split('\n')
    partial[chunk.stream] = pieces.pop() ?? ''
    for (const piece of pieces) lines.push({ stream: chunk.stream, text: clip(settle(piece)) })
  }

  return pushLines({ ...run, partial }, lines)
}

const SECRET_PROMPT = /pass(word|ord|phrase)?|token|secret|hemmelig|api.?key|\bpin\b/i

export function isSecretPrompt(prompt: string): boolean {
  return SECRET_PROMPT.test(prompt)
}

/** The prompt a script is waiting at: the unfinished tail of its output. */
export function pendingPrompt(run: Run): string {
  return settle(run.partial.stdout) || settle(run.partial.stderr)
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1).replace('.', ',')} s`
  const minutes = Math.floor(seconds / 60)

  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`
}

/**
 * Runs its arguments in a pseudo-terminal, copying stdin in and the terminal out.
 * Shell scripts need one: bash shows `read -p`'s prompt only to a terminal, and
 * `read -s` hides an answer by turning the terminal's echo off.
 */
export const PTY = 'import os, pty, sys; sys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))'

/**
 * Starts the command after `$1` with its stdin on a FIFO in the folder `$1`, so
 * answers can be written while it runs. fd 3 holds the FIFO open so a script
 * reading stdin waits rather than meets EOF, and `$1/pid` lets the pane stop it.
 */
export const WRAPPER = `d="$1"; shift
mkfifo "$d/in" || exit 97
"$@" < "$d/in" &
p=$!
echo "$p" > "$d/pid"
trap 'kill "$p" 2>/dev/null' TERM HUP INT
exec 3>"$d/in"
wait "$p"; c=$?
exec 3>&-
rm -f "$d/in" "$d/pid"; rmdir "$d" 2>/dev/null
exit "$c"`
