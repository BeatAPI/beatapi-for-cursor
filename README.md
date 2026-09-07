# BeatAPI for Cursor

Official Cursor client for BeatAPI. Sign in once with a BeatAPI account and
every text model on it becomes available inside Cursor, together with its
context window, its price and your balance.

The repository contains two parts:

- [`BeatCursor/`](./BeatCursor) — the extension: a local server that answers
  Cursor's agent requests from BeatAPI, and the sidebar panel.
- [`installer/`](./installer) — [`beatcursor`](https://www.npmjs.com/package/beatcursor),
  the command-line installer that adds the extension and applies the patches
  Cursor needs.

## What users can do

- sign in through the browser, without pasting a key into the editor;
- use every text model on the account, grouped by family, with its context
  window, retail price and discount;
- read the account balance and per-model usage in the sidebar, or from a
  keyboard shortcut;
- top up credits without leaving the editor;
- switch routing between BeatAPI and Cursor's own backend at any time.

The catalogue, context windows, output limits and prices are read from the
gateway at runtime, so a model added on the account appears in Cursor without
a new release of this client.

## Requirements

- Cursor, installed in a standard location — macOS, Linux and Windows are
  detected automatically
- Node.js 18 or newer
- A BeatAPI account. Create one at <https://beatapi.io>.

## Install

```bash
npx beatcursor
```

Run with no arguments in a terminal and it opens a menu: install, reinstall,
uninstall, status. Quit Cursor before installing, and restart it afterwards.

The non-interactive form, for scripts and documentation:

```bash
npx -y beatcursor@latest install
```

Hosted scripts, which check Node and then call the same CLI:

```bash
curl -fsSL https://beatapi.io/install.sh | sh
```

```powershell
irm https://beatapi.io/install.ps1 | iex
```

Neither script contains install logic. There is one copy of that, in the npm
package.

## Commands

| Command | What it does |
|---|---|
| `beatcursor` | Interactive menu, when attached to a terminal |
| `beatcursor install` | Install the extension and patch Cursor |
| `beatcursor update` | Restore the originals, then install this version |
| `beatcursor uninstall` | Remove the extension and restore every patched file |
| `beatcursor status` | Report what is installed and what is not |
| `beatcursor check` | Dry run: verify the patch targets still match |

Subcommands are the scripting interface; their behaviour and exit codes do not
change when the menu does. Without a terminal — a pipe, CI, `curl … | sh` — the
bare command prints help instead of waiting for a keypress.

## Signing in

Authorization follows the loopback redirect flow for native applications
(RFC 8252 §7.3). The extension opens a one-time listener on `127.0.0.1`, the
system browser opens the BeatAPI authorization page, and the account approves
the request there. Passwords and second factors stay in the browser; the editor
never sees them.

The extension then holds exactly one credential: a relay key, which is what
answers for model access, balance and usage. It holds no browser session and no
personal access token, so it cannot change the password, mint further keys or
move money.

Signing out clears the local copy. The key itself stays on the account until it
is revoked from the dashboard.

## In the editor

| Action | Shortcut |
|---|---|
| Show balance and usage | `⌘⌥U` — `Ctrl+Alt+U` |
| Top up credits | `⌘⌥B` — `Ctrl+Alt+B` |

The panel opens from the activity bar: usage first, then the models grouped by
family, then routing. Everything else is in the command palette under
`BeatCursor:` — signing in and out, refreshing models, switching routing, and
opening the routes, providers and log files.

## What it changes

Installing patches files inside the Cursor application — the renderer hook,
request routing and the signature check — and sets two keys in Cursor's
`settings.json`. Every patched file is backed up with a timestamp first, and
`beatcursor uninstall` restores all of them.

`cursor.general.disableHttp2` is set to `true`. Cursor's agent stream defaults
to an HTTP/2 bidirectional call, which cannot run over the HTTP/1.1 path this
installer sets up; without the setting, the first message fails with
*"An unexpected error occurred on our servers"*.

Configuration lives in `~/.beatcursor/`. `routes.json` is replaced on install;
`providers.json` is kept if it already exists.

## Build from source

```bash
cd installer
npm install
npm run build:all           # the extension vsix, then this CLI
node dist/cli.cjs status
node dist/cli.cjs install
```

## Credits

BeatAPI for Cursor is a modified distribution of **CCursor** (Cursor++), a
Cursor integration by **Haleclipse** (cometix), released under the GNU
AGPL-3.0-or-later. The upstream project made this integration possible; this
fork adapts it to sign in with a [BeatAPI](https://beatapi.io) account and to
route model traffic to the BeatAPI gateway.

See [`NOTICE`](./NOTICE) for attribution.

## License

GNU Affero General Public License v3.0 or later. See [`LICENSE`](./LICENSE).
