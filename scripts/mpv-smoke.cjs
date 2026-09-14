'use strict';
// The full-format player without a window: mpv-host.js starts the helper the build carries, the helper loads the libmpv it
// finds, a clip plays, and the frames that land in the shared memory are checked to be a picture — then the controls go
// over mpv's IPC (pause, a seek) and come back as state. The workflow runs this on every build, on Windows against the
// libmpv-2.dll it ships and on Linux against the runner's own libmpv2, inside Electron's runtime.
//   NEBULA_MPV_HELPER=<helper> NEBULA_MPV_LIB=<libmpv> electron scripts/mpv-smoke.cjs <clip>   (ELECTRON_RUN_AS_NODE=1)
const path = require('path');
const host = require(path.join(__dirname, '..', 'mpv-host.js'));
const CLIP = process.argv[2];
const fail = (m) => { console.error('mpv smoke: FAIL — ' + m); try { host.dispose(); } catch (e) {} setTimeout(() => process.exit(1), 300); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
if (!CLIP) fail('usage: electron scripts/mpv-smoke.cjs <clip>');

(async () => {
  if (!host.available()) return fail(host.whyNot());
  if (!(await host.probe())) return fail('the probe found no libmpv that works: ' + host.whyNot());
  let opened = false, err = '';
  host.on((e) => { if (e.type === 'loaded') opened = true; if (e.type === 'end' && e.reason === 'error') err = e.error + (e.detail ? ' — ' + e.detail : ''); });
  try { await host.start(); } catch (e) { return fail('the helper did not start: ' + e.message); }
  host.want(320, 180);
  host.load(path.resolve(CLIP), {});
  const t0 = Date.now();
  while (!opened && !err && Date.now() - t0 < 20000) await wait(50);
  if (err) return fail('the clip would not open: ' + err);
  if (!opened) return fail('the clip did not open in 20 s');
  const first = Math.max(0, host.count());
  let sd = 0;
  while (Date.now() - t0 < 30000 && host.count() - first < 30) await wait(100);
  const f = host.frame(-1), got = host.count() - first;
  if (!f || got < 30) return fail('only ' + got + ' frames in 30 s');
  const v = f.view; let n = 0, s = 0, s2 = 0;
  for (let i = 0; i < f.w * f.h * 4; i += 4 * 37) { const l = 0.299 * v[i] + 0.587 * v[i + 1] + 0.114 * v[i + 2]; n++; s += l; s2 += l * l; }
  sd = Math.sqrt(Math.max(0, s2 / n - (s / n) * (s / n)));
  const st = host.snapshot(), tracks = JSON.parse(host.get('track-list') || '[]').map((t) => t.type + ':' + t.codec).join(' ');
  console.log('mpv ' + host.version() + ' · ' + got + ' frames at ' + f.w + 'x' + f.h + ', picture spread ' + sd.toFixed(1) + ', draw ' + st.drawMs + ' ms, time-pos ' + (st.t || 0).toFixed(2) + ' s, tracks ' + tracks);
  if (sd < 10) return fail('the frames are not a picture (spread ' + sd.toFixed(1) + ')');
  if (!(st.t > 0.5)) return fail('the clock did not move');
  if (!/video:/.test(tracks) || !/audio:/.test(tracks)) return fail('the track list lacks video or audio: ' + tracks);
  host.set('pause', 'yes'); await wait(600);
  const p1 = host.snapshot().t; await wait(600); const p2 = host.snapshot();
  if (p2.pause !== true || Math.abs(p2.t - p1) > 0.1) return fail('pause did not hold (' + JSON.stringify({ pause: p2.pause, p1, p2: p2.t }) + ')');
  host.command(['seek', '2', 'absolute']); await wait(1200);
  const s3 = host.snapshot().t;
  if (!(Math.abs(s3 - 2) < 0.6)) return fail('the seek did not land (' + s3 + ')');
  console.log('pause holds at ' + p2.t.toFixed(2) + ' s, a seek to 2 s lands at ' + s3.toFixed(2) + ' s');
  host.dispose();
  console.log('mpv smoke: OK');
  setTimeout(() => process.exit(0), 300);
})().catch((e) => fail(e && e.stack || e));
