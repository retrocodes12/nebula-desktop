# Nebula for Windows

The desktop surface of [Nebula](https://github.com/retrocodes12/nebula-player), a streaming
player for the TV, the desktop and the phone. A thin Electron shell around the shared player:
add your add-on, browse its catalogs, press play. Encrypted streams are decrypted on the device
itself.

**Site:** https://play.rifflehq.in ·
**Installer:** [Nebula-Setup.exe](https://github.com/retrocodes12/nebula-desktop/releases/latest/download/Nebula-Setup.exe) ·
**Portable:** [Nebula-Portable.exe](https://github.com/retrocodes12/nebula-desktop/releases/latest/download/Nebula-Portable.exe)

## What the desktop adds

The player itself is the one that runs on the web and on LG TVs — every feature listed in the
[main README](https://github.com/retrocodes12/nebula-player#what-it-does) is here: pause board,
playback HUD, instant next episode, sleep timer, profiles, friends, watch parties. On top of it:

- **Mini player.** `Shift+M` (or the button in the player) shrinks the window to a 480×300
  always-on-top corner player and puts it back where it was when you leave.
- **Keyboard.** `?` lists every shortcut: K/J/L, M, S/A/Q for the pickers, N for the next
  episode, Z for the sleep timer, I for the HUD, digits to jump, `/` to search.
- **Local serving.** The renderer is served from a loopback HTTP server inside the app, so the
  player runs under the same rules as the web build; external links open in your browser.
- **Clean exit.** Closing the window quits the app and its server — nothing lingers in the tray.

## Repo layout

```
main.js          window, loopback server, mini-mode IPC, quit-on-close, external-link policy
preload.js       contextBridge: window.nebulaDesktop.setMiniMode(on)
renderer/        the shared player (a copy of nebula-player/webos-player/index.html + assets)
build/           icons
.github/workflows/build-win.yml   builds and publishes a release on every push to main
```

## Building

Releases are built by GitHub Actions on `windows-latest` (`npm run dist` → electron-builder,
NSIS installer + portable exe) and published on every push to `main`. Locally:

```
npm install
npm start          # run against renderer/
npm run dist       # Windows installer + portable into dist/
```

The renderer is never edited here — changes land in `nebula-player/webos-player/index.html` and
are copied over, so the three builds stay one player.

## Security

See [SECURITY.md](SECURITY.md).
