/** One script the menu can run, as the scan found it. */
export type Script = {
  /** Relative to the project root. */
  path: string
  /** Python runs on the project's interpreter; shell runs on its own, in a pty. */
  kind: 'python' | 'shell'
  /** A shell script's interpreter: its shebang's words, else one by its suffix. */
  interpreter: string[]
  /**
   * The nearest virtual environment's python above the script, relative to the
   * root (`pipeline/.venv/bin/python`): Python runs on it, and either kind runs
   * with it activated.
   */
  venv?: string
  name: string
  /** The folder, relative to the root; '' at the root. */
  dir: string
  description: string
  /** Has a `__main__` guard, a shebang, or sits in a scripts folder. */
  isLikely: boolean
  /** Calls input(), `read` or a prompt helper: answers go through the pane. */
  asksInput: boolean
  /** Uses getpass or `read -s`. */
  asksSecret: boolean
  /** Uses curses, fzf, dialog or a menu library that needs a real terminal. */
  needsTerminal: boolean
  /** argparse, click, typer, fire, docopt, getopts or a usage text: `--help` says something. */
  hasHelp: boolean
  /** Carries PEP 723 inline metadata (`# /// script`). */
  isUvScript: boolean
}

export type ScanStatus = 'idle' | 'scanning' | 'done' | 'failed'

export type Scan = {
  status: ScanStatus
  root: string
  /** The interpreter: the project's venv, else the login shell's python3. */
  python: string
  /** Where `uv` is, for scripts with inline metadata. */
  uv?: string
  /** The login shell's PATH, which an app started from the Dock lacks. */
  envPath?: string
  message?: string
}

export type Prefs = {
  /** Starred script paths, relative to the root. */
  starred: string[]
  /** The arguments last used per script path. */
  args: Record<string, string>
}

export type LineStream = 'stdout' | 'stderr' | 'stdin' | 'info'

export type OutputLine = {
  stream: LineStream
  text: string
  /** For a stdin line: the prompt the answer was given to. */
  prompt?: string
}

export type RunStatus = 'running' | 'done' | 'failed' | 'stopped'

export type Run = {
  id: string
  path: string
  argsText: string
  status: RunStatus
  code: number | null
  startedAt: number
  endedAt?: number
  lines: OutputLine[]
  /** Lines dropped from the front to keep the pane light. */
  dropped: number
  /** Text written after the last newline, per stream: usually a prompt. */
  partial: { stdout: string; stderr: string }
  /** The temp folder holding the stdin FIFO and the pid file. */
  dir?: string
  /** Runs in a pseudo-terminal, which echoes answers itself. */
  isTerminal?: boolean
  isStopping?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'script-menu': {
      scripts: Shaped<Script[]>
      scan: Shaped<Scan>
      prefs: Shaped<Prefs>
      runs: Shaped<Record<string, Run>>
      drafts: Record<string, string>
      selected: string | null
      filter: string
      showAll: boolean
      /** The first row of the scrolling list, under the favourites. */
      listOffset: number
      /** The person closed the pane: it is not opened again unasked this session. */
      closedByHand: boolean
    }
  }
}
