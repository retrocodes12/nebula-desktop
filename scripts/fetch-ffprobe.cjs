// Puts ffprobe beside the ffmpeg that ffmpeg-static installed: node_modules/ffmpeg-static/ffprobe(.exe).
//
// Until 2026-09-24 ffprobe came from the ffprobe-static package, whose binaries are FFmpeg 4.0.2 from 2018 — and ffprobe
// is the first thing to parse a file an add-on points at. ffmpeg-static's own binary release carries a matching ffprobe
// for every platform, so it comes from there: the same release tag ffmpeg-static uses, each file pinned by its sha256.
// A bump of ffmpeg-static that moves its release tag stops here until the hashes below are updated with it.
//
//   node scripts/fetch-ffprobe.cjs            (CI runs it after npm install, on Windows and Linux)
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');

const TAG = 'b6.1.1';
const PINNED = {                       // sha256 of the .gz asset in that release
  'linux-x64': '25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067',   // ffprobe 7.0.2 (johnvansickle static)
  'win32-x64': 'f309e6223ad89d2fe54bccd420a7709b66fd27540674e92309578ed491a43c8d',   // ffprobe 6.1.1 (gyan.dev essentials)
};

const pkgDir = path.dirname(require.resolve('ffmpeg-static/package.json'));
const pkg = require('ffmpeg-static/package.json');
const tag = pkg['ffmpeg-static'] && pkg['ffmpeg-static']['binary-release-tag'];
if (tag !== TAG) { console.error('ffmpeg-static now uses release ' + tag + ', this script pins ' + TAG + ': update TAG and PINNED together'); process.exit(1); }
const plat = process.env.FFPROBE_PLATFORM || (process.platform + '-' + process.arch);
const want = PINNED[plat];
if (!want) { console.error('no pinned ffprobe for ' + plat); process.exit(1); }
const url = 'https://github.com/eugeneware/ffmpeg-static/releases/download/' + TAG + '/ffprobe-' + plat + '.gz';
const out = path.join(pkgDir, plat.startsWith('win32') ? 'ffprobe.exe' : 'ffprobe');

function get(u, hops) {
  return new Promise((ok, no) => {
    https.get(u, { headers: { 'User-Agent': 'nebula-desktop-build' } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && hops < 5) { r.resume(); return ok(get(new URL(r.headers.location, u).href, hops + 1)); }
      if (r.statusCode !== 200) { r.resume(); return no(new Error(u + ' → ' + r.statusCode)); }
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => ok(Buffer.concat(chunks))); r.on('error', no);
    }).on('error', no);
  });
}

(async () => {
  const gz = await get(url, 0);
  const got = crypto.createHash('sha256').update(gz).digest('hex');
  if (got !== want) { console.error('ffprobe-' + plat + '.gz: sha256 ' + got + ', pinned ' + want + ' — refusing it'); process.exit(1); }
  fs.writeFileSync(out + '.part', zlib.gunzipSync(gz));
  fs.chmodSync(out + '.part', 0o755);
  fs.renameSync(out + '.part', out);
  console.log('ffprobe (' + TAG + ', ' + plat + ', sha256 ok) → ' + path.relative(process.cwd(), out));
})().catch((e) => { console.error(e.message || e); process.exit(1); });
