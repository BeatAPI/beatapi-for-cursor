<p align="center">
  <img src="BeatCursor/resources/logo.png" width="96" alt="BeatCursor" />
</p>

<h1 align="center">BeatCursor</h1>

<p align="center">
  <strong>Use your <a href="https://beatapi.io">BeatAPI</a> account inside Cursor</strong>
</p>

---

## What it does

Sign in once with your BeatAPI account and every text model on it becomes
available inside Cursor — with its context window, its price and your balance,
all read live from the gateway.

- **No key pasting.** Authorization happens in your browser; the editor never
  sees a credential.
- **Models are data.** The catalogue, context limits and prices come from
  `GET /v1/text/models`, so adding a model needs no client release.
- **Balance and usage** in the sidebar. `⌘⌥B` tops up, `⌘⌥U` shows usage.

## Install

```bash
cd installer
npm install
npm run build:all          # build the extension + the installer
node dist/cli.cjs install  # patch Cursor and install the extension
node dist/cli.cjs status   # verify
node dist/cli.cjs uninstall # restore everything
```

Close Cursor before installing, and restart it afterwards.

## Layout

```
BeatCursor/   the extension (local server + panel)
installer/    patches Cursor and installs the extension
```

## Credits

BeatCursor is a modified distribution of **CCursor** (Cursor++), a Cursor
integration by **Haleclipse** (cometix), released under the GNU
AGPL-3.0-or-later. The upstream project made the Cursor integration possible;
this fork adapts it to sign in with a [BeatAPI](https://beatapi.io) account and
route to the BeatAPI gateway.

See [`NOTICE`](NOTICE) for attribution and [`LICENSE`](LICENSE) for the full
license text.
