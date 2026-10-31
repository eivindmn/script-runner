import { expect, test } from 'claude-code/testing'

import type { Run } from '../types'
import { applyChunks, describe, inspectSource, isCandidate, isSkippedPath, pendingPrompt, splitArgs } from '../hooks/text'

const RUN: Run = {
  id: '1',
  path: 'a.py',
  argsText: '',
  status: 'running',
  code: null,
  startedAt: 0,
  lines: [],
  dropped: 0,
  partial: { stdout: '', stderr: '' },
}

test('arguments split as a shell would', async () => {
  expect(splitArgs(`--env 'staging prod' -n 3 "a \\"b\\"" c\\ d`)).toEqual([
    '--env',
    'staging prod',
    '-n',
    '3',
    'a "b"',
    'c d',
  ])
  expect(splitArgs('   ')).toEqual([])
  expect(splitArgs(`--name ''`)).toEqual(['--name', ''])
})

test('a description comes from the docstring, a comment or argparse', async () => {
  expect(describe('#!/usr/bin/env python3\n"""Deployer til staging.\n\nMer tekst."""\n')).toBe('Deployer til staging.')
  expect(describe('# -*- coding: utf-8 -*-\n# Rydder i loggene\nimport os\n')).toBe('Rydder i loggene')
  expect(describe('import argparse\np = argparse.ArgumentParser(description="Lager rapport")\n')).toBe('Lager rapport')
  expect(describe('import os\n')).toBe('')
})

test('the source says what a script needs', async () => {
  const script = inspectSource(
    'scripts/ask.py',
    'import getpass\nname = input("Navn: ")\nif __name__ == "__main__":\n    pass\n',
  )
  expect(script?.kind).toBe('python')
  expect(script?.isLikely).toBe(true)
  expect(script?.asksInput).toBe(true)
  expect(script?.asksSecret).toBe(true)
  expect(script?.needsTerminal).toBe(false)
  expect(inspectSource('menu.py', 'import questionary\n')?.needsTerminal).toBe(true)
  expect(inspectSource('lib/util.py', 'def f():\n    return 1\n')?.isLikely).toBe(false)
})

test('a shell script runs on its shebang, else on a shell for its suffix', async () => {
  const setup = inspectSource(
    'scripts/setup.sh',
    '#!/usr/bin/env bash\n# shellcheck disable=SC2034\n# Setter opp miljøet\nset -e\nread -r -p "Navn: " name\nread -s -p "Passord: " pw\n',
  )
  expect(setup?.kind).toBe('shell')
  expect(setup?.interpreter).toEqual(['/usr/bin/env', 'bash'])
  expect(setup?.description).toBe('Setter opp miljøet')
  expect(setup?.asksInput).toBe(true)
  expect(setup?.asksSecret).toBe(true)
  expect(setup?.isLikely).toBe(true)

  const zsh = inspectSource('lib/env.zsh', 'export A=1\n')
  expect(zsh?.interpreter).toEqual(['/bin/zsh'])
  expect(zsh?.isLikely).toBe(false)
  expect(inspectSource('build.sh', 'echo hi\n')?.isLikely).toBe(true)
  expect(inspectSource('pick.sh', 'choice=$(ls | fzf)\n')?.needsTerminal).toBe(true)
  expect(inspectSource('opts.sh', 'while getopts "h" o; do :; done\n')?.hasHelp).toBe(true)

  // Suffixless files count by their shebang alone; one with a python shebang is Python.
  expect(inspectSource('bin/release', '#!/bin/sh\necho release\n')?.interpreter).toEqual(['/bin/sh'])
  expect(inspectSource('bin/notes', 'just text\n')).toBeUndefined()
  expect(inspectSource('bin/tool', '#!/usr/bin/env python3\nprint(1)\n')?.kind).toBe('python')
})

test('candidates are Python and shell files, and suffixless files in script folders', async () => {
  expect(isCandidate('a.py')).toBe(true)
  expect(isCandidate('deploy.sh')).toBe(true)
  expect(isCandidate('bin/setup')).toBe(true)
  expect(isCandidate('tools/x/run')).toBe(true)
  expect(isCandidate('README')).toBe(false)
  expect(isCandidate('scripts/notes.md')).toBe(false)
})

test('environments, caches and tests are skipped', async () => {
  expect(isSkippedPath('.venv/lib/x.py')).toBe(true)
  expect(isSkippedPath('pkg/__init__.py')).toBe(true)
  expect(isSkippedPath('tests/test_a.py')).toBe(true)
  expect(isSkippedPath('scripts/deploy.py')).toBe(false)
})

test('output folds into lines and keeps the prompt as the tail', async () => {
  const run = applyChunks(RUN, [
    { stream: 'stdout', text: 'Hei\nNa' },
    { stream: 'stdout', text: 'vn: ' },
    { stream: 'stderr', text: '\u001b[31m 10%\r 50%\r100%\n' },
  ])
  expect(run.lines).toEqual([
    { stream: 'stdout', text: 'Hei' },
    { stream: 'stderr', text: '100%' },
  ])
  expect(pendingPrompt(run)).toBe('Navn: ')
})
