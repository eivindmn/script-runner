# script-runner
Running Python and shells etc in Claude Code app, without the terminal.

A Claude Code mod (`script-menu`) that finds the Python and shell scripts in the project you're working in and lists them in a pane beside the chat. Pick one, give it arguments and run it, without opening a terminal or asking Claude to do it for you.

The pane's text is in Norwegian.

## Install

At the prompt of a terminal session:

```
/plugin install script-menu --marketplace eivindmn/script-runner
```

Answer `y` to add the marketplace, then press Enter to install it for your user (all your projects).

From a shell:

```bash
claude plugin install script-menu --marketplace eivindmn/script-runner
```

In the desktop app, where `/plugin` doesn't run: click + next to the prompt box, then Plugins, Add marketplace with `eivindmn/script-runner`, then Add plugin.

## Use

Type `/scripts` to open the pane, or `/scripts <search>` to jump straight to a script.

- **▶ / ■** starts and stops a script. It runs from the project root, and the first line of its output is the exact command.
- **Arguments** are remembered per script. **--help** runs the script with `--help` when it has argparse, click, typer, getopts or a usage text.
- **☆ / ★** stars a script. Starred scripts sit at the top, and stars are kept per project.
- **Answers while it runs:** when a script asks for input (`input()`, `getpass`, `read -p`, click/typer prompts), the prompt shows in the pane with a field under it. Type and press Enter, and the line goes to the script's stdin. Passwords aren't echoed.
- **Åpne i Terminal** opens the script in Terminal.app instead, for scripts that need a real terminal (curses, fzf, dialog, questionary and the like). The pane warns you about these.
- **Spør Claude om feilen** puts the end of a failed run's output in the prompt box, so you can ask Claude about it.

## What it finds

Files ending in `.py`, `.sh`, `.bash`, `.zsh` or `.command`, and files without a suffix that start with a shebang in folders like `bin/`, `scripts/` and `tools/`. It reads git's file list, so ignored files stay out.

By default it shows the scripts that look runnable: a `__main__` guard, a shebang, or a place in a scripts folder. **Vis alle filer** shows the rest. Virtual environments, caches, `tests/`, `test_*.py`, `__init__.py`, `setup.py` and the like are always left out.

## Which Python

For each script, it looks for a virtual environment (`.venv`, `venv`, `env`, `.env`, or another folder with `pyvenv.cfg`) in the script's folder, then in each folder above it up to the project root. The nearest one is used and activated (`VIRTUAL_ENV` and `PATH`), for shell scripts too. So `pipeline/tools/make_sounds.py` runs as `pipeline/.venv/bin/python pipeline/tools/make_sounds.py` when `pipeline/.venv` exists.

Without one, it uses `python3` from your login shell's `PATH`. Scripts with PEP 723 inline metadata (`# /// script`) run with `uv run --script` when `uv` is installed. Environments outside the project, like Poetry's or Conda's, aren't found.

Shell scripts run on their shebang, in a pseudo-terminal so `read -p` prompts show up. That takes Python 3.9 or newer.

## Requirements

macOS (Terminal.app and a zsh login shell are assumed). It may work elsewhere, but it hasn't been tried.

## Develop

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
