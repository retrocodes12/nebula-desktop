'use strict';
// Sound for the TV: a television that cannot play a film's audio (an LG on webOS 6 drops DTS without a word — the picture
// plays, no audio track is listed, measured 2026-10-12) has this computer convert it. The TV's player asks, on the same
// token-gated listener as Share with your TV (relay.js):
//   GET /relay/probe?src=<file>&h=<headers>&k=<token>        what the file holds (convert.js probe)
//   GET /relay/seg?src=…&t=&len=&a=&ch=&ac=&vc=&st=&k=…        one piece as fragmented MP4: the picture copied as it is
//                                                             (HEVC 10-bit and its HDR included), the audio → E-AC-3
// and appends the pieces itself, so the TV keeps a real timeline: seeking, the length and subtitles work as for any file.
// healthz says what this computer offers ({ sound: { codec: 'ec-3' } }) so a TV only routes a film here when it can.
//
// Safety, on top of the listener's token: http(s) files only, and only from the internet — the host and every redirect
// are resolved, checked and pinned (source.js guard, relay.js privateTarget), so whoever holds the token cannot reach this
// machine or the network it sits on. At most a few conversions at once; everything stops when sharing stops.
const conv = require('./convert'), source = require('./source');
const dns = require('dns');

const MAX_SEGS = 3;            // pieces converting at once (one TV pumps one at a time; a seek can overlap the old one briefly)
const MAX_PROBES = 2;
// the rigs' headless Chromium decodes no Dolby: NEBULA_TVSOUND_CODEC=opus makes the same pieces with Opus audio
const CODEC = process.env.NEBULA_TVSOUND_CODEC === 'opus' ? 'opus' : 'eac3';
const TAG = CODEC === 'opus' ? 'opus' : 'ec-3';
const httpUrl = (u) => /^https?:\/\/[^\s"'<>]{4,4000}$/i.test(u || '');

let relay = null, ready = () => Promise.resolve(false), probes = 0;
const kids = new Set();        // { ff, res } of every conversion running for the TV

function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
function busy(res) { res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '1' }); res.end('busy'); }
/** The file's host must be on the internet: resolved here first, so a refusal is a clear 403 rather than a failed probe. */
function hostOk(src) {
  return new Promise((ok) => {
    let h = ''; try { h = new URL(src).hostname; } catch (e) { ok(false); return; }
    dns.lookup(h, (err, address) => ok(!err && !relay.privateTarget(address)));
  });
}
/** What is common to both routes: FFmpeg here, an http(s) file on the internet, the add-on's headers. */
async function gate(res, u) {
  const src = u.searchParams.get('src') || '';
  if (!(await ready())) { json(res, 501, { error: 'no ffmpeg' }); return null; }
  if (!httpUrl(src)) { json(res, 400, { error: 'bad src' }); return null; }
  if (!(await hostOk(src))) { json(res, 403, { error: 'refused address' }); return null; }
  return { src, hd: source.parseHeaders(u.searchParams.get('h')) };
}
function track(ff, res, seg) {
  if (!ff) return;
  const k = { ff, res, seg: !!seg }; kids.add(k);
  ff.on('close', () => kids.delete(k));
  ff.on('error', () => kids.delete(k));
}
async function probe(req, res, u) {
  if (probes >= MAX_PROBES) return busy(res);
  probes++;
  let gone = false; req.on('close', () => { gone = true; });
  try {
    const g = await gate(res, u); if (!g || gone) return;
    const ff = await conv.probe(g.src, g.hd, res, { guard: relay.privateTarget, gone: () => gone });
    if (ff) { track(ff, res, false); await new Promise((ok) => { ff.on('close', ok); ff.on('error', ok); }); }
  } catch (e) { if (!res.headersSent) json(res, 502, { error: 'probe failed', detail: String((e && e.message) || e) }); }
  finally { probes--; }
}
async function seg(req, res, u) {
  const g = await gate(res, u); if (!g || req.destroyed) return;
  let n = 0; kids.forEach((k) => { if (k.seg) n++; });
  if (n >= MAX_SEGS) return busy(res);
  track(await conv.segment(u.searchParams, g.hd, req, res, { tv: true, codec: CODEC, guard: relay.privateTarget }), res, true);
}
/** Sharing stopped (the switch, the app closing): no conversion outlives it. */
function stopAll() {
  kids.forEach((k) => { try { k.ff.kill('SIGKILL'); } catch (e) {} try { k.res.destroy(); } catch (e) {} });
  kids.clear();
}

/** Put the TV's sound routes on the sharing listener. `isReady()` → Promise<bool>: FFmpeg and FFprobe run here. */
function attach(r, isReady) {
  relay = r; ready = isReady || ready;
  relay.route('/relay/probe', (req, res, u) => { probe(req, res, u).catch(() => { try { if (!res.headersSent) res.writeHead(500); res.end(); } catch (e) {} }); });
  relay.route('/relay/seg', (req, res, u) => { seg(req, res, u).catch(() => { try { if (!res.headersSent) res.writeHead(500); res.end(); } catch (e) {} }); });
  relay.health(() => ready().then((ok) => (ok ? { sound: { codec: TAG, v: 1 } } : {}), () => ({})));
  relay.onStop(stopAll);
}
module.exports = { attach, stopAll, running: () => kids.size, CODEC, TAG };
