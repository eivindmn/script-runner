import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PTY } from '../hooks/text'

const ROOT = '/repo'

const FILES: Record<string, string> = {
  'scripts/deploy.py': '"""Deployer til staging."""\nimport argparse\nif __name__ == "__main__":\n    pass\n',
  'scripts/ask.py': 'name = input("Navn: ")\nprint("Takk", name)\n',
  'lib/helpers.py': 'def helper():\n    return 1\n',
  'scripts/setup.sh': '#!/usr/bin/env bash\n# Setter opp miljøet\nread -p "Navn: " name\necho "Takk $name"\n',
  'bin/release': '#!/bin/sh\necho release\n',
  'scripts/notes.md': '# Not a script\n',
  'pipeline/tools/make_sounds.py': '"""Lager lydene."""\nimport numpy\nif __name__ == "__main__":\n    pass\n',
}

// The one virtual environment in the repo: pipeline/.venv, as a project with its own tooling has.
const VENV = `${ROOT}/pipeline/.venv`

const PANE = {
  plugin: 'script-menu',
  component: 'Pane',
  requestId: 'scripts',
  props: {
    title: 'Scripts',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

/** The engine beneath the mod: a repo of a few files, a shell and a clock. */
function world(on: On, extra: Record<string, string> = {}) {
  const files: Record<string, string> = { ...FILES, ...extra }
  const clock = mock.clock(on, { now: 1000 })
  const stored = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => {
    stored.set(e.key, e.value)

    return { value: undefined }
  })
  const seen = {
    spawned: [] as (readonly string[])[],
    envs: [] as (Record<string, string> | undefined)[],
    answers: [] as string[],
    opened: [] as string[],
  }
  on('session.root', () => ({ value: ROOT }))
  on('session.surfaces', () => ({ value: [] }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('command.register', () => ({ value: { command: 'scripts' } }))
  on('ui.open', (_, e) => {
    seen.opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: [...new Set(seen.opened)].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('fs.list', (_, e) =>
    e.path === `${ROOT}/pipeline`
      ? { value: [{ name: '.venv', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }
      : { value: [] },
  )
  on('fs.exists', (_, e) => ({ value: e.path === `${VENV}/bin/python` }))
  on('fs.read', (_, e) => {
    const file = files[String(e.path).slice(ROOT.length + 1)]

    return file === undefined ? { deny: 'ENOENT' } : { value: file }
  })
  on('process.run', (_, e) => {
    const [command] = e.argv
    const ok = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (command === 'git') return ok(`${Object.keys(files).join('\0')}\0`)
    if (command === '/bin/zsh') return ok('/usr/bin:/bin\n/usr/bin/python3\n')
    if (command === 'mktemp') return ok('/tmp/script-menu.x\n')
    if (command === '/bin/sh') {
      seen.answers.push(String(e.argv[4]))

      return ok('')
    }

    return ok('')
  })
  on('process.spawn', async function* (_, e) {
    seen.spawned.push(e.argv)
    seen.envs.push(e.env)
    yield { stream: 'stdout' as const, text: 'Hei!\nNavn: ' }
    while (seen.answers.length === 0) await clock.sleep(20)
    yield { stream: 'stdout' as const, text: `Takk ${seen.answers[0]}\n` }

    return { value: { code: 0, signal: null } }
  })

  return { clock, seen, stored }
}

test('the menu lists the scripts and stars one, on terminal and desktop', async ($, on) => {
  const { stored } = world(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'rescan' })

    expect(await ui.find({ key: 'open:scripts/deploy.py' })).toBeDefined()
    expect(await ui.find({ key: 'open:scripts/ask.py' })).toBeDefined()
    expect(await ui.find({ key: 'open:scripts/setup.sh' })).toBeDefined()
    expect(await ui.find({ key: 'open:bin/release' })).toBeDefined()
    expect(await ui.find({ key: 'open:scripts/notes.md' })).toBeUndefined()
    // No __main__ guard and not in a scripts folder: only under "show all".
    expect(await ui.find({ key: 'open:lib/helpers.py' })).toBeUndefined()
    await ui.press({ key: 'show-all' })
    expect(await ui.find({ key: 'open:lib/helpers.py' })).toBeDefined()
    await ui.press({ key: 'show-all' })

    if ((await ui.find({ type: 'Text', text: /Favoritter/ })) === undefined) {
      await ui.press({ key: 'star:scripts/deploy.py' })
    }
    expect(await ui.find({ type: 'Text', text: /Favoritter/ })).toBeDefined()
    expect((await ui.find({ key: 'star:scripts/deploy.py' }))?.text).toBe('★')
    await ui.unmount()
  }

  // Stars outlive the session: they are kept per project in the store.
  expect(stored.get(`prefs:${ROOT}`)).toEqual({ starred: ['scripts/deploy.py'], args: {} })
})

test('a script runs with its arguments and takes an answer while it runs', async ($, on) => {
  const { clock, seen, stored } = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'rescan' })
  await ui.press({ key: 'open:scripts/ask.py' })

  await ui.input({ key: 'args', text: `--env 'staging prod'` })
  // No virtual environment above scripts/: the login shell's python3.
  expect(seen.spawned[0]?.slice(-5)).toEqual(['/usr/bin/python3', '-u', 'scripts/ask.py', '--env', 'staging prod'])

  await clock.advance(100)
  expect(await ui.find({ type: 'Text', text: /Venter på svar/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Navn: ' })).toBeDefined()

  await ui.input({ key: 'answer', text: 'Eivind' })
  expect(seen.answers).toEqual(['Eivind'])
  await clock.advance(100)

  expect(await ui.find({ type: 'Text', text: 'Takk Eivind' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Ferdig/ })).toBeDefined()
  // The answer is echoed after its prompt, as a terminal shows it.
  expect(await ui.find({ type: 'Text', text: 'Eivind' })).toBeDefined()
  await ui.unmount()

  expect(stored.get(`prefs:${ROOT}`)).toEqual({
    starred: [],
    args: { 'scripts/ask.py': `--env 'staging prod'` },
  })
})

test('a shell script runs on its shebang in a pty, which echoes answers itself', async ($, on) => {
  const { clock, seen } = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'rescan' })
  await ui.press({ key: 'open:scripts/setup.sh' })
  await ui.press({ key: 'run' })

  const argv = seen.spawned[0] ?? []
  expect(argv.slice(argv.lastIndexOf('-c'), argv.lastIndexOf('-c') + 2)).toEqual(['-c', PTY])
  expect(argv.slice(-3)).toEqual(['/usr/bin/env', 'bash', 'scripts/setup.sh'])
  expect(await ui.find({ type: 'Text', text: '$ bash scripts/setup.sh' })).toBeDefined()

  await clock.advance(100)
  expect(await ui.find({ type: 'Text', text: /Venter på svar/ })).toBeDefined()
  await ui.input({ key: 'answer', text: 'Eivind' })
  expect(seen.answers).toEqual(['Eivind'])
  await clock.advance(100)

  expect(await ui.find({ type: 'Text', text: /Ferdig/ })).toBeDefined()
  // No echo of the pane's own: the prompt is left for the terminal's echo to finish.
  expect(await ui.find({ type: 'Text', text: 'Navn: ' })).toBeDefined()
  await ui.unmount()
})

test('a script runs on the nearest virtual environment above it, activated', async ($, on) => {
  const { clock, seen } = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'rescan' })
  await ui.press({ key: 'open:pipeline/tools/make_sounds.py' })
  expect(await ui.find({ type: 'Text', text: 'Miljø: pipeline/.venv' })).toBeDefined()

  await ui.press({ key: 'run' })
  expect(seen.spawned[0]?.slice(-3)).toEqual([`${VENV}/bin/python`, '-u', 'pipeline/tools/make_sounds.py'])
  expect(seen.envs[0]?.VIRTUAL_ENV).toBe(VENV)
  expect(seen.envs[0]?.PATH).toBe(`${VENV}/bin:/usr/bin:/bin`)
  // Run from the root, as `pipeline/.venv/bin/python pipeline/tools/make_sounds.py` would be typed.
  expect(await ui.find({ type: 'Text', text: '$ pipeline/.venv/bin/python pipeline/tools/make_sounds.py' })).toBeDefined()

  await clock.advance(100)
  await ui.input({ key: 'answer', text: 'ok' })
  await clock.advance(100)
  await ui.unmount()
})

test('a surface without text fields still lists and runs', async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  await ui.press({ key: 'rescan' })
  expect(await ui.find({ key: 'run:scripts/deploy.py' })).toBeDefined()
  await ui.unmount()
})

test('the pane opens by itself beside the transcript on the desktop, and scans', async ($, on) => {
  const { clock, seen } = world(on)
  await $.session.attach({ surface: 'mobile', clientId: 'mobile:default', viewport: { columns: 40, rows: 30, isFullscreen: false } })
  await clock.advance(10)
  expect(seen.opened).toEqual([])

  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default', viewport: { columns: 60, rows: 40, isFullscreen: true } })
  await clock.advance(10)
  expect(seen.opened).toEqual(['scripts'])

  // Scanned unasked: the list is there without pressing ↻.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'open:scripts/deploy.py' })).toBeDefined()
  await ui.unmount()

  // Already open: a second client does not open it again.
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:two', viewport: { columns: 60, rows: 40, isFullscreen: true } })
  await clock.advance(10)
  expect(seen.opened).toEqual(['scripts'])
})

test('a long list scrolls in a window under the favourites', async ($, on) => {
  const jobs = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`scripts/job${String(i + 1).padStart(2, '0')}.py`, 'print(1)\n']),
  )
  world(on, jobs)
  // 16 rows: 11 go to the header, search, favourites and footer, 5 to the list and its ▲ ▼ line.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, scroll: { offset: 0, bodyRows: 16 } } })
  await ui.press({ key: 'rescan' })
  await ui.press({ key: 'star:scripts/deploy.py' })

  const showing = async () => {
    const keys: string[] = []
    for (const path of [...Object.keys(FILES), ...Object.keys(jobs)]) {
      if (path === 'scripts/deploy.py') continue
      if ((await ui.find({ key: `open:${path}` })) !== undefined) keys.push(path)
    }

    return keys
  }
  const before = await showing()
  expect(before.length).toBe(4)
  expect(await ui.find({ type: 'Text', text: /^1–4 av 16$/ })).toBeDefined()

  await ui.press({ key: 'list-down' })
  const after = await showing()
  expect(after.length).toBe(4)
  expect(after.some(path => before.includes(path))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /^5–8 av 16$/ })).toBeDefined()
  // The favourite stays at the top whatever the list shows.
  expect(await ui.find({ key: 'open:scripts/deploy.py' })).toBeDefined()

  await ui.press({ key: 'list-up' })
  await ui.press({ key: 'list-up' })
  expect(await showing()).toEqual(before)
  await ui.unmount()
})
