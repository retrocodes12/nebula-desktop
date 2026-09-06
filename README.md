# Nebula for the desktop

The desktop surface of [Nebula](https://github.com/retrocodes12/nebula-player), a streaming
player for the TV, the desktop and the phone. A thin Electron shell around the shared player:
add your add-on, browse its catalogs, press play. Encrypted streams are decrypted on the device
itself. Windows 10 and 11, or a 64-bit Linux desktop.

**Site:** https://play.rifflehq.in

| | | |
|---|---|---|
| **Windows** | [Nebula-Setup.exe](https://github.com/retrocodes12/nebula-desktop/releases/latest/download/Nebula-Setup.exe) | installer |
| | [Nebula-Portable.exe](https://github.com/retrocodes12/nebula-desktop/releases/latest/download/Nebula-Portable.exe) | runs without installing |
| **Linux** | [Nebula.AppImage](https://github.com/retrocodes12/nebula-desktop/releases/latest/download/Nebula.AppImage) | `chmod +x` it and open it |
| | [Nebula.deb](https://github.com/retrocodes12/nebula-desktop/releases/latest/download/Nebula.deb) | `sudo apt install ./Nebula.deb` |

## What the desktop adds

The player itself is the one that runs on the web and on LG TVs — every feature listed in the
[main README](https://github.com/retrocodes12/nebula-player#what-it-does) is here: pause board,
playback HUD, instant next episode, sleep timer, profiles, friends, watch parties. On top of it:

- **Every file plays.** Dolby Digital, Dolby Digital Plus, DTS and TrueHD audio, which Chromium
  cannot decode, are converted to AAC as they play by the FFmpeg the app carries; video the machine
  cannot decode is converted too. The file's languages are listed under Audio.
- **Drop to play.** Drag a video file onto the window and it plays here.
- **Mini player.** `Shift+M` (or the button in the player) shrinks the window to a 480×300
  always-on-top corner player and puts it back where it was when you leave.
- **Keyboard.** `?` lists every shortcut: K/J/L, M, S/A/Q for the pickers, N for the next
  episode, Z for the sleep timer, I for the HUD, digits to jump, `/` to search.
- **Local serving.** The renderer is served from a loopback HTTP server inside the app, so the
  player runs under the same rules as the web build; external links open in your browser.
- **Clean exit.** Closing the window quits the app and its server — nothing lingers in the tray.
- **It updates itself.** Every build looks for a new release when it starts and every six hours,
  and installs it on restart: the installer silently, the portable exe by swapping its own file,
  the AppImage the same way, the .deb through `dpkg` (which asks for your password). A build
  unpacked by hand updates itself no more than a checkout does — the player links to the release.

## Repo layout

```
main.js          window, loopback server, FFmpeg /probe + /seg, the updater, mini-mode IPC
preload.js       contextBridge: window.nebulaDesktop (mini mode, flush, transcode, update)
renderer/        the shared player (a copy of nebula-player/webos-player/index.html + assets)
build/           icons
.github/workflows/build-desktop.yml   builds Windows and Linux, then cuts one release per push to main
```

## Building

Releases are built by GitHub Actions on every push to `main`: `windows-latest` builds the NSIS
installer and the portable exe, `ubuntu-latest` builds the AppImage and the .deb, and a third job
puts all of it in one release. Locally:

```
npm install
npm start            # run against renderer/
npm run dist         # Windows installer + portable into dist/
npm run dist:linux   # AppImage + deb into dist/
```

The renderer is never edited here — changes land in `nebula-player/webos-player/index.html` and
are copied over, so the three builds stay one player.

## Security

See [SECURITY.md](SECURITY.md).
