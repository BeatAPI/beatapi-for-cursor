# beatcursor

Installs the **BeatCursor** extension into Cursor and applies the patches it needs,
so the editor talks to your BeatAPI account instead of Cursor's backend.

## Install

```bash
npx beatcursor
```

Run it with no arguments in a terminal and it opens a menu — install, reinstall,
uninstall, status. Quit Cursor first; restart it afterwards.

One-liner, for scripts and docs:

```bash
npx -y beatcursor@latest install
```

### Hosted install scripts

macOS / Linux:

```bash
curl -fsSL https://beatapi.io/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://beatapi.io/install.ps1 | iex
```

Two scripts because native Windows has no `sh` — Git Bash and WSL do, but those
belong to people who already have a dev environment set up. Both do the same
thing: check Node, warn if Cursor is running, then run `beatcursor install`.
Neither contains any install logic; there is one copy of that, in this package.

Sources are in [`scripts/`](scripts/).

## Commands

| Command | What it does |
|---|---|
| `beatcursor` | Interactive menu (only when attached to a terminal) |
| `beatcursor install` | Install the extension and patch Cursor |
| `beatcursor update` | Restore originals, then install this version |
| `beatcursor uninstall` | Remove the extension and restore every patched file |
| `beatcursor status` | Report what is installed and what is not |
| `beatcursor check` | Dry-run: verify the patch targets still match |

Subcommands are the scripting interface — their behaviour and exit codes do not
change when the menu does. Without a TTY (a pipe, CI, `curl … | sh`) the bare
command prints this help instead of opening a menu, so it can never hang waiting
for a keypress.

## What it changes

Files inside `Cursor.app` (renderer hook, request routing, signature check) and
two settings in your Cursor `settings.json`. Every patched file is backed up with
a timestamp first, and `uninstall` restores all of them.

`cursor.general.disableHttp2` is set to `true`: Cursor's agent stream defaults to
HTTP/2 bidi, which cannot run over the HTTP/1.1 path this installer sets up, and
the failure shows up as *"An unexpected error occurred on our servers"*.

Configuration lives in `~/.beatcursor/`.

## Build from source

```bash
npm run build:all           # extension vsix + this CLI
node dist/cli.cjs status
```
