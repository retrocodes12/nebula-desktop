'use strict';
// The full-format player without a window (the workflow runs it on every build): mpv-host.js probes and starts the helper
// the build carries, a clip plays, its frames come from the helper's frame server the way the page fetches them and must be
// a picture, pause and a seek go over mpv's IPC and come back as state — and what must be refused is: a command outside the
// list (mpv's own `run`), a property outside it, an address that is not http(s), a file nobody picked, a frame request
// without the token.   NEBULA_MPV_HELPER=<helper> NEBULA_MPV_LIB=<libmpv> node scripts/mpv-smoke.cjs <clip>
//                      (the workflow runs it inside Electron's runtime: ELECTRON_RUN_AS_NODE=1 electron scripts/mpv-smoke.cjs)
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const host = require(path.join(__dirname, '..', 'mpv-host.js'));
const CLIP = process.argv[2], ORIGIN = 'http://127.0.0.1:47313';
const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const canary = path.join(os.tmpdir(), 'nebula-smoke-canary-' + process.pid);
const fail = (m) => { console.error('mpv smoke: FAIL — ' + m); try { host.dispose(); } catch (e) {} try { fs.unlinkSync(canary); } catch (e) {} setTimeout(() => process.exit(1), 300); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function grab(url) {
  return new Promise((ok) => {
    const r = http.get(url, { agent }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => ok({ status: res.statusCode, body: Buffer.concat(c), acao: res.headers['access-control-allow-origin'] }));
    });
    r.on('error', (e) => ok({ status: 0, err: e.message }));
    r.setTimeout(5000, () => r.destroy(new Error('timeout')));
  });
}
function frameOf(b) {
  if (!b || b.length < 32 || b.readUInt32LE(0) !== 0x46504d4e) return null;
  return { w: b.readUInt32LE(4), h: b.readUInt32LE(8), stride: b.readUInt32LE(12), gen: b.readUInt32LE(20), count: b.readUInt32LE(24) + b.readUInt32LE(28) * 4294967296, px: b.subarray(32) };
}

(async () => {
  if (!CLIP) return fail('usage: node scripts/mpv-smoke.cjs <clip>');
  host.setOrigin(ORIGIN);
  if (!host.available()) return fail(host.whyNot());
  if (!(await host.probe())) return fail('the probe found no libmpv that works: ' + host.whyNot());
  let opened = false, err = '', ends = [];
  host.on((e) => { if (e.type === 'loaded') opened = true; if (e.type === 'end') { ends.push(e); if (e.reason === 'error') err = e.error + (e.detail ? ' — ' + e.detail : ''); } });
  try { await host.start(); } catch (e) { return fail('the helper did not start: ' + e.message); }
  const base = host.frameBase();
  if (!/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/f$/.test(base)) return fail('no frame address (' + base + ')');

  // ---- what must be refused
  host.command(['run', process.platform === 'win32' ? 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? '/c' : '-c', 'echo x > "' + canary + '"']);
  host.set('stream-record', canary); host.set('pause', 'no; run x');
  if (host.grant(path.resolve(__filename)) !== '') return fail('a script was granted as a film');
  host.load('file:///etc/passwd', {});
  await wait(400);
  if (!ends.some((e) => e.reason === 'error' && /cannot be played/.test(e.error))) return fail('a file:// address was not refused');
  if (!(host.load('/etc/hostname', {}).ok === false)) return fail('a path nobody picked was not refused');
  const bad = await grab(base.replace(/[0-9a-f]{32}\/f$/, '0'.repeat(32) + '/f') + '?after=0&w=64&h=36');
  if (bad.status !== 404) return fail('a frame request without the token was answered ' + bad.status);
  ends = []; err = '';

  // ---- a clip, played
  const id = host.grant(path.resolve(CLIP));
  if (!/^local:\d+$/.test(id)) return fail('the clip was not granted');
  host.load(id, { aheadSecs: 30, alang: 'en,eng' });
  const t0 = Date.now();
  while (!opened && !err && Date.now() - t0 < 20000) await wait(50);
  if (err) return fail('the clip would not open: ' + err);
  if (!opened) return fail('the clip did not open in 20 s');
  let last = 0, got = 0, f = null, r = null;
  while (got < 30 && Date.now() - t0 < 30000) {
    r = await grab(base + '?after=' + last + '&w=320&h=180&pad=1');
    if (r.status === 200) { const x = frameOf(r.body); if (x) { f = x; last = x.count; got++; } }
    else if (r.status !== 204) return fail('a frame request was answered ' + r.status + (r.err ? ' (' + r.err + ')' : ''));
  }
  if (got < 30 || !f) return fail('only ' + got + ' frames in 30 s');
  if (f.w !== 320 || f.h !== 180 || f.stride % 64 || f.stride < 320 * 4) return fail('the frame is ' + f.w + 'x' + f.h + ' with rows of ' + f.stride + ' bytes');
  if (r.acao !== ORIGIN) return fail('the frame server answered origin ' + r.acao);
  let n = 0, sum = 0, sq = 0;
  for (let y = 0; y < f.h; y += 3) for (let x = 0; x < f.w; x += 3) { const i = y * f.stride + x * 4, l = 0.299 * f.px[i] + 0.587 * f.px[i + 1] + 0.114 * f.px[i + 2]; n++; sum += l; sq += l * l; }
  const sd = Math.sqrt(Math.max(0, sq / n - (sum / n) * (sum / n)));
  const st = host.snapshot(), tracks = JSON.parse(host.get('track-list') || '[]').map((t) => t.type + ':' + t.codec).join(' ');
  console.log('mpv ' + host.version() + ' · ' + got + ' frames at ' + f.w + 'x' + f.h + ' (rows of ' + f.stride + ' bytes), picture spread ' + sd.toFixed(1) + ', time-pos ' + (st.t || 0).toFixed(2) + ' s, tracks ' + tracks);
  if (sd < 10) return fail('the frames are not a picture (spread ' + sd.toFixed(1) + ')');
  if (!(st.t > 0.5)) return fail('the clock did not move');
  if (!/video:/.test(tracks) || !/audio:/.test(tracks)) return fail('the track list lacks video or audio: ' + tracks);
  host.set('pause', 'yes'); await wait(600);
  const p1 = host.snapshot().t; await wait(600); const p2 = host.snapshot();
  if (p2.pause !== true || Math.abs(p2.t - p1) > 0.1) return fail('pause did not hold (' + JSON.stringify({ pause: p2.pause, p1, p2: p2.t }) + ')');
  host.command(['seek', '2', 'absolute']); await wait(1200);
  const s3 = host.snapshot().t;
  if (!(Math.abs(s3 - 2) < 0.6)) return fail('the seek did not land (' + s3 + ')');
  if (fs.existsSync(canary)) return fail('mpv ran a program the page asked for');
  console.log('pause holds at ' + p2.t.toFixed(2) + ' s, a seek to 2 s lands at ' + s3.toFixed(2) + ' s; run, stream-record, file://, an unpicked path and a wrong token were refused');
  // HDR arrives as coded on this platform's libmpv (mpv-host labels every frame SDR): a PQ-flagged frame and its SDR-flagged
  // twin come out alike, and the file is reported as PQ (the page's shader then tone-maps it)
  if (process.env.HDR_PAIR) {
    const means = [];
    for (const clip of process.env.HDR_PAIR.split(',').map((x) => path.resolve(x))) {
      opened = false; err = '';
      host.load(host.grant(clip), { start: 1 });
      const t1 = Date.now();
      while (!opened && !err && Date.now() - t1 < 15000) await wait(50);
      if (!opened) return fail('the HDR pair would not open: ' + (err || clip));
      await wait(900); host.set('pause', 'yes'); await wait(700);
      let lc = 0, fr = null;
      for (let i = 0; i < 40; i++) { const x = await grab(base + '?after=' + lc + '&w=320&h=180&pad=1'); if (x.status !== 200) break; const y = frameOf(x.body); if (!y) break; fr = y; lc = y.count; }
      if (!fr) return fail('no frame from ' + path.basename(clip));
      const sum = [0, 0, 0]; let k = 0;
      for (let y = 0; y < fr.h; y += 3) for (let x = 0; x < fr.w; x += 3) { const i = y * fr.stride + x * 4; sum[0] += fr.px[i]; sum[1] += fr.px[i + 1]; sum[2] += fr.px[i + 2]; k++; }
      means.push({ gamma: host.get('video-params/gamma'), mean: sum.map((v) => Math.round(v / k)) });
    }
    const d = Math.max(...means[0].mean.map((v, i) => Math.abs(v - means[1].mean[i])));
    console.log('HDR pair ' + JSON.stringify(means) + ', largest difference ' + d);
    if (means[0].gamma !== 'pq') return fail('the PQ clip was reported as ' + means[0].gamma);
    if (d > 8) return fail('the HDR frame was converted on the CPU (it must arrive as coded for the page to tone-map)');
  }
  host.dispose();
  console.log('mpv smoke: OK');
  setTimeout(() => process.exit(0), 300);
})().catch((e) => fail(e && e.stack || e));
