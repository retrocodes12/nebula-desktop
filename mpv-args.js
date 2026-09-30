'use strict';
// What the page may hand the full-format player, checked (main process; mpv-host.js): a file the user picked, the address
// of a load, and a load's options — and the sweep of what an earlier Nebula left in the temporary folder. Nothing here
// talks to mpv.
const path = require('path'), fs = require('fs'), os = require('os');

const MEDIA_FILE = /\.(mkv|mk3d|mp4|m4v|mov|avi|webm|ts|m2ts|mts|mpg|mpeg|vob|wmv|flv|ogv|3gp|mka|mp3|m4a|aac|flac|wav|ogg|opus|ac3|eac3|dts)$/i;
const grants = new Map();                               // id → a local file the user picked (load('local:<id>'))
let grantSeq = 0;

/** A local file the user picked, remembered so that load() can name it without the page ever sending a path: media only. */
function grant(p) {
  try {
    if (typeof p !== 'string' || !path.isAbsolute(p) || !MEDIA_FILE.test(p) || !fs.statSync(p).isFile()) return '';
  } catch (e) { return ''; }
  for (const [id, q] of grants) if (q === p) return 'local:' + id;
  const id = ++grantSeq;
  grants.set(id, p);
  return 'local:' + id;
}
/** What load() will hand mpv: an http(s) address (no control characters) or a granted file; '' for anything else. */
function target(u) {
  if (typeof u !== 'string' || u.length > 8192) return '';
  const g = /^local:(\d{1,9})$/.exec(u);
  if (g) return grants.get(Number(g[1])) || '';
  if (!/^https?:\/\/[^\s/?#]+/i.test(u) || /[\x00-\x1f\x7f]/.test(u)) return '';
  return u.replace(/ /g, '%20');
}
function clean(o) {
  const num = (v, lo, hi, d) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi ? v : d);
  const line = (v, max) => (typeof v === 'string' && v.length <= max && !/[\r\n\0]/.test(v) ? v : '');
  const langs = (v) => (typeof v === 'string' && /^[a-z]{2,3}(,[a-z]{2,3}){0,7}$/.test(v) ? v : '');
  const headers = [];
  if (o.headers && typeof o.headers === 'object') {
    Object.keys(o.headers).slice(0, 20).forEach((k) => {
      const v = line(String(o.headers[k] == null ? '' : o.headers[k]), 2048);
      if (v && /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(k)) headers.push([k, v]);
    });
  }
  return { start: num(o.start, 0, 1e7, 0), ua: line(o.ua, 512) || 'Nebula', headers, alang: langs(o.alang), slang: langs(o.slang),
    aheadSecs: num(o.aheadSecs, 0, 3600, 0), maxBytes: Math.round(num(o.maxBytes, 16, 2048, 150)),
    aid: typeof o.aid === 'string' && /^\d{1,3}$/.test(o.aid) ? o.aid : 'auto', speed: String(num(o.speed, 0.25, 4, 1)),
    volume: Math.round(num(o.volume, 0, 130, 100)), mute: o.mute === true, pause: o.pause === true, again: o.again === true };
}

/** What a Nebula that ended without cleaning up left behind (a socket folder, subtitle files): removed when its process is gone. */
function sweep() {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  try {
    fs.readdirSync(os.tmpdir()).forEach((f) => {
      const m = /^nebula-mpv-(\d+)-/.exec(f);
      if (m && Number(m[1]) !== process.pid && !alive(Number(m[1]))) { try { fs.rmSync(path.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (e) {} }
    });
  } catch (e) {}
}

module.exports = { grant, target, clean, sweep };
