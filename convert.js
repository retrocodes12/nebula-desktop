'use strict';
// FFmpeg's two jobs for a player that cannot take a file as it is: /probe (what the file holds) and /seg (one piece of
// it as fragmented MP4, the video copied, the audio re-encoded) — and /speech for the subtitle timing. Moved out of
// main.js on 2026-10-14 so the TV's sound helper (tvsound.js) runs the same code on the network: the loopback page gets
// stereo AAC (Chromium decodes nothing else that matters), a television gets E-AC-3 5.1 (it decodes Dolby, not DTS).
const { spawn } = require('child_process');
const source = require('./source'), { retime } = require('./retime');

let FFMPEG = 'ffmpeg', FFPROBE = 'ffprobe', agent = () => '';
// FFmpeg reads every file through source.js on loopback — its Linux build crashes on a host-name lookup — and the host
// sees the page's own User-Agent (ffmpeg's "Lavf" is what hosts block); -reconnect rides out a dropped connection.
const NET = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '4'];

// What the file holds: duration, the video codec, every audio and subtitle track. When FFprobe cannot read it,
// what the host did instead (a 403, a page) — the player turns that into a sentence.
// `o.guard` (the TV's requests): the host and every redirect must be on the internet (source.js refuses the rest).
async function probe(src, hd, res, o) {
  const input = await source.urlFor(src, hd, agent(), o && o.guard);
  if (o && o.gone && o.gone()) return null;
  // the track list sits in the header: a second of packets is plenty, and keeps a 25 Mbps remux from costing 16 MB per play
  const ff = spawn(FFPROBE, ['-v', 'error', ...NET, '-print_format', 'json', '-show_streams', '-show_format', '-analyzeduration', '1M', '-probesize', '5M', input], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch (e) {} }, 25000);
  ff.stdout.on('data', (d) => { out += d; });
  ff.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
  // a spawn that fails (the binary gone or busy while an update replaces the unpacked files, no file
  // descriptors left) emits 'error' — unhandled, that is an uncaught exception in the main process
  ff.on('error', (e) => {
    clearTimeout(timer);
    if (res.headersSent) return;
    res.statusCode = 502; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'probe failed', http: 0, notmedia: false, detail: 'ffprobe could not start: ' + (e && e.message || e) }));
  });
  ff.on('close', () => {
    clearTimeout(timer);
    if (res.headersSent) return;
    let j = null; try { j = JSON.parse(out); } catch (e) {}
    if (!j || !Array.isArray(j.streams) || !j.streams.length) {
      const http = /(?:HTTP error|Server returned) (\d{3})/.exec(err);
      const body = { error: 'probe failed', http: http ? Number(http[1]) : 0, notmedia: /Invalid data found|does not contain any stream/i.test(err), detail: err.split(input).join('<file>').trim().slice(-200) };
      res.statusCode = 502; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); return;
    }
    const v = j.streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic)) || null;
    const audio = j.streams.filter((s) => s.codec_type === 'audio').map((s, i) => ({
      i, codec: s.codec_name || '', channels: s.channels || 0, lang: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || '',
      title: (s.tags && (s.tags.title || s.tags.TITLE)) || '', dflt: !!(s.disposition && s.disposition.default),
    }));
    const subs = j.streams.filter((s) => s.codec_type === 'subtitle').map((s, i) => ({ i, codec: s.codec_name || '', lang: (s.tags && s.tags.language) || '', title: (s.tags && s.tags.title) || '' }));
    const body = {
      duration: Number((j.format && j.format.duration) || (v && v.duration) || 0) || 0, start: Number((j.format && j.format.start_time) || 0) || 0,
      bitrate: Number((j.format && j.format.bit_rate) || 0) || 0,   // bits per second (a TV sizes its pieces by it)
      video: v ? { codec: v.codec_name || '', width: v.width || 0, height: v.height || 0, profile: v.profile || '', pix_fmt: v.pix_fmt || '', transfer: v.color_transfer || '' } : null,
      audio, subs,
    };
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body));
  });
  return ff;
}

// One piece of the file from second `t`, `len` seconds long, as fragmented MP4. FFmpeg counts each track's fragments
// from 0 whatever -copyts says; retime.js moves them to where the file has them (delay_moov writes that down), so the
// player drops the piece straight onto its timeline. Video is copied unless `v=h264` asks; audio track `a` → stereo AAC.
/** The audio of one piece: stereo AAC for the page on this computer; for a television E-AC-3 — what an LG decodes and passes on
    to a sound bar — copied when the track already is (`ac=copy`), 5.1 at most (the encoder stops there; 7.1 is folded down). */
function audioArgs(q, o) {
  if (!o.tv) return ['-c:a', 'aac', '-ac', '2', '-b:a', '192k'];
  if (q.get('ac') === 'copy') return ['-c:a', 'copy'];
  const ch = Math.max(0, Math.floor(Number(q.get('ch')) || 0));
  if (o.codec === 'opus') return ['-c:a', 'libopus', '-ac', '2', '-b:a', '160k'];   // the rigs: headless Chromium decodes no Dolby
  return ['-c:a', 'eac3', '-b:a', ch >= 5 || !ch ? '640k' : '256k', ...(ch > 6 || !ch ? ['-ac', '6'] : [])];
}
// `o.tv`: the piece is for a television — the video always copied, the audio E-AC-3 (`o.codec`, see tvsound.js) or copied
// as it is (`ac=copy`, a track that already is E-AC-3), never more than six channels (`ch` = the track's own count).
async function segment(q, hd, req, res, o) {
  o = o || {};
  if (o.tv) return segmentTv(q, hd, req, res, o);
  const src = q.get('src') || '';
  const t = Math.max(0, Number(q.get('t')) || 0), len = Math.min(30, Math.max(2, Number(q.get('len')) || 10));
  const a = Math.max(0, Number(q.get('a')) || 0), vmode = q.get('v') === 'h264' && !o.tv ? 'h264' : 'copy', vcodec = q.get('vc') || '', st = Math.max(0, Number(q.get('st')) || 0);
  // -ss before -i lands on the keyframe at or before t (fast, needed for a video copy); -to with -copyts then runs the
  // piece up to the absolute time t+len, so a long keyframe gap never leaves the requested second uncovered
  const input = await source.urlFor(src, hd, agent(), o.guard); if (req.destroyed) return;   // the player moved on while the loopback server started
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...NET, '-ss', String(t), '-i', input, '-to', String(t + len),
    '-map', '0:v:0', '-map', '0:a:' + a, '-sn', '-dn'];
  // ultrafast, never above 1080 lines (the pieces only cross loopback): an i3-3217U re-encodes 1080p HEVC at 0.94× real time so, 0.52× on veryfast
  if (vmode === 'h264') args.push(...(Number(q.get('vh')) > 1080 ? ['-vf', 'scale=-2:1080'] : []), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p', '-g', '48', '-force_key_frames', 'expr:gte(t,n_forced*2)');
  else { args.push('-c:v', 'copy'); if (/hevc|h265/i.test(vcodec)) args.push('-tag:v', 'hvc1'); }
  args.push(...audioArgs(q, o), '-copyts', '-f', 'mp4', '-movflags', 'frag_keyframe+delay_moov+default_base_moof', '-frag_duration', '1000000', 'pipe:1');
  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '', killed = false;
  ff.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
  ff.stdout.pipe(retime(st)).pipe(res);   // st: where the file's own clock starts (an MPEG-TS at 1.4 s) — the player's starts at 0
  const kill = () => { killed = true; try { ff.kill('SIGKILL'); } catch (e) {} };   // the player left the piece (a seek, Back): not a failure
  req.on('close', kill);
  ff.on('error', (e) => { console.error('ffmpeg seg spawn', e && e.message || e); try { res.destroy(); } catch (e2) {} });   // never an uncaught exception
  ff.on('close', (code, sig) => { if ((code || sig) && !res.writableEnded) { try { res.destroy(); } catch (e) {} } if ((code || sig) && !killed) console.error('ffmpeg seg exit', code || sig, err.trim().slice(-300)); });   // a crash is a failed piece, never an empty one
  return ff;
}

// The same piece for a television, as TWO streams in one answer. An LG (webOS 6) takes E-AC-3 only in a source buffer of
// its own: "video/mp4; codecs=hvc1…, ec-3" is refused, a picture buffer + an "audio/mp4; codecs=ec-3" buffer play (measured
// on his TV, 10-14 — HDR kept). So one FFmpeg reads the file ONCE and writes the picture (copied) to fd 3 and the sound to
// fd 4, each fragmented MP4 on the file's own timeline (retime.js each); the answer interleaves them as frames — one byte
// 'V' or 'A', four bytes of length (big-endian), the bytes — which the player feeds to its two buffers.
const TAG_V = 0x56, TAG_A = 0x41;
function frame(tag, d) { const h = Buffer.allocUnsafe(5); h[0] = tag; h.writeUInt32BE(d.length, 1); return Buffer.concat([h, d]); }
async function segmentTv(q, hd, req, res, o) {
  const src = q.get('src') || '';
  const t = Math.max(0, Number(q.get('t')) || 0), len = Math.min(30, Math.max(2, Number(q.get('len')) || 10));
  const a = Math.max(0, Number(q.get('a')) || 0), vcodec = q.get('vc') || '', st = Math.max(0, Number(q.get('st')) || 0);
  const input = await source.urlFor(src, hd, agent(), o.guard); if (req.destroyed) return;
  const MP4 = ['-f', 'mp4', '-movflags', 'frag_keyframe+delay_moov+default_base_moof', '-frag_duration', '1000000'];
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', ...NET, '-copyts', '-ss', String(t), '-i', input,
    '-map', '0:v:0', '-sn', '-dn', '-an', '-c:v', 'copy', ...(/hevc|h265/i.test(vcodec) ? ['-tag:v', 'hvc1'] : []), '-to', String(t + len), ...MP4, 'pipe:3',
    '-map', '0:a:' + a, '-sn', '-dn', '-vn', ...audioArgs(q, o), '-to', String(t + len), ...MP4, 'pipe:4'];
  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let err = '', killed = false, open = 2;
  ff.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-4000); });
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Nebula-Split': '1' });
  const outs = [ff.stdio[3].pipe(retime(st)), ff.stdio[4].pipe(retime(st))];
  // both outputs pause together while the TV is behind (one paused alone would stall FFmpeg's other output and deadlock)
  const resume = () => outs.forEach((x) => x.resume());
  outs.forEach((s, i) => {
    s.on('data', (d) => { if (!res.write(frame(i ? TAG_A : TAG_V, d))) { outs.forEach((x) => x.pause()); res.once('drain', resume); } });
    s.on('end', () => { if (--open === 0 && !res.writableEnded) res.end(); });
    s.on('error', () => { try { res.destroy(); } catch (e) {} });
  });
  const kill = () => { killed = true; try { ff.kill('SIGKILL'); } catch (e) {} };
  req.on('close', kill);
  ff.on('error', (e) => { console.error('ffmpeg tv seg spawn', e && e.message || e); try { res.destroy(); } catch (e2) {} });
  ff.on('close', (code, sig) => { if ((code || sig) && !res.writableEnded) { try { res.destroy(); } catch (e) {} } if ((code || sig) && !killed) console.error('ffmpeg tv seg exit', code || sig, err.trim().slice(-300)); });
  return ff;
}

// The voices of audio track `a` from second `t`, for the player's automatic subtitle timing: 16 kHz mono s16le, decoded as
// fast as the file arrives (it needs minutes of speech, and waiting for playback to reach them would take as long). A film's
// dialogue is its centre channel (5.1 / 7.1 / 3.0), or what both sides share in stereo — so the track's layout is asked first.
async function speech(q, hd, req, res) {
  const src = q.get('src') || '';
  const t = Math.max(0, Number(q.get('t')) || 0), len = Math.min(600, Math.max(10, Number(q.get('len')) || 360)), a = Math.min(99, Math.max(0, Math.floor(Number(q.get('a')) || 0)));
  const input = await source.urlFor(src, hd, agent()); if (req.destroyed) return;
  const channels = await new Promise((ok) => {
    let out = '', p;
    try { p = spawn(FFPROBE, ['-v', 'error', ...NET, '-select_streams', 'a:' + a, '-show_entries', 'stream=channels', '-of', 'csv=p=0', input], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { ok(0); return; }
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) {} }, 20000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(timer); ok(0); });
    p.on('close', () => { clearTimeout(timer); ok(parseInt(out, 10) || 0); });
  });
  if (req.destroyed) return;
  if (!channels) { res.statusCode = 502; res.end('no audio'); return; }
  const pan = channels === 3 || channels >= 5 ? 'pan=mono|c0=c2' : channels === 1 ? 'anull' : 'pan=mono|c0=0.5*c0+0.5*c1';
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...NET, '-ss', String(t), '-i', input, '-t', String(len),
    '-map', '0:a:' + a, '-vn', '-sn', '-dn', '-af', pan, '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => { err += d; if (err.length > 2000) err = err.slice(-2000); });
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
  ff.stdout.pipe(res);
  req.on('close', () => { try { ff.kill('SIGKILL'); } catch (e) {} });   // the sync found its answer, or stopped
  ff.on('error', (e) => { console.error('ffmpeg speech spawn', e && e.message || e); try { res.destroy(); } catch (e2) {} });
  ff.on('close', (code, sig) => { if (code && !res.writableEnded) { try { res.destroy(); } catch (e) {} } if (code) console.error('ffmpeg speech exit', code, err.trim().slice(-300)); });
}

/** Where the two tools are (main.js finds them inside the app) and the User-Agent the hosts see (the page's own). */
function setup(o) { if (o.ffmpeg) FFMPEG = o.ffmpeg; if (o.ffprobe) FFPROBE = o.ffprobe; if (o.agent) agent = o.agent; }
module.exports = { setup, probe, segment, speech };
