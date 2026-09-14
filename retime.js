'use strict';
// The converter's pieces, put back on the file's own timeline.
//
// Each piece is a fresh FFmpeg started at the keyframe before second t (-ss before -i, the video copied, the audio
// re-encoded from exactly t, -copyts). The MP4 muxer counts every track's fragments from 0 (tfdt 0 — measured on
// FFmpeg 7.0.2 with every flag that might have helped), and with delay_moov it says where each track really starts as
// an edit list: an empty edit as long as the track's first presentation time, then the media from its first
// composition offset. Video and audio start at different times in one piece (the keyframe vs t). MSE places a fragment
// by its tfdt alone, so every piece landed at 0 s — over what had already played — and the playhead starved at the end
// of the second one (09-14, a 4 GB MKV stuck at 33 s). This stream moves each track's tfdt to (empty edit − media
// start − the file's own start time), in the track's own units — the player's timeline starts at 0 where the file
// starts, and an MPEG-TS starts at 1.4 s — and renames the edit list 'free' so nothing applies it twice. Sizes never change.
const { Transform } = require('stream');

function kids(buf, start, end, cb) {
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p), hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) return;
    cb(buf.toString('latin1', p + 4, p + 8), p + hdr, p + size, p);
    p += size;
  }
}
const u32at = (buf, s, v1) => buf.readUInt32BE(s + (v1 ? 20 : 12));   // tkhd track_ID, mdhd/mvhd timescale
/** track_ID → how far its fragments must move (in its own timescale); each edit list becomes a 'free' box. */
function fromMoov(box, shift) {
  let movieScale = 1000; const tracks = [];
  kids(box, 8, box.length, (t, s, e) => {
    if (t === 'mvhd') movieScale = u32at(box, s, box[s] === 1) || 1000;
    if (t !== 'trak') return;
    const tr = { id: 0, scale: 0, empty: 0, start: 0 };
    kids(box, s, e, (t2, s2, e2, b2) => {
      if (t2 === 'tkhd') tr.id = u32at(box, s2, box[s2] === 1);
      if (t2 === 'mdia') kids(box, s2, e2, (t3, s3) => { if (t3 === 'mdhd') tr.scale = u32at(box, s3, box[s3] === 1); });
      if (t2 === 'edts') {
        kids(box, s2, e2, (t3, s3) => {
          if (t3 !== 'elst') return;
          const v1 = box[s3] === 1, n = box.readUInt32BE(s3 + 4); let q = s3 + 8, media = false;
          for (let i = 0; i < n && !media; i++) {
            const dur = v1 ? Number(box.readBigUInt64BE(q)) : box.readUInt32BE(q), mt = v1 ? Number(box.readBigInt64BE(q + 8)) : box.readInt32BE(q + 4);
            if (mt === -1) tr.empty += dur; else { tr.start = mt; media = true; }
            q += v1 ? 20 : 12;
          }
        });
        box.write('free', b2 + 4, 'latin1');
      }
    });
    tracks.push(tr);
  });
  const offs = {};
  tracks.forEach((tr) => { if (tr.id && tr.scale) offs[tr.id] = Math.max(0, Math.round((tr.empty / movieScale - (shift || 0)) * tr.scale) - tr.start); });
  return offs;
}
function patchMoof(box, offs) {
  kids(box, 8, box.length, (t, s, e) => {
    if (t !== 'traf') return;
    let id = 0;
    kids(box, s, e, (t2, s2) => {
      if (t2 === 'tfhd') id = box.readUInt32BE(s2 + 4);
      if (t2 !== 'tfdt' || !offs[id]) return;
      if (box[s2] === 1) box.writeBigUInt64BE(box.readBigUInt64BE(s2 + 4) + BigInt(offs[id]), s2 + 4);
      else { const v = box.readUInt32BE(s2 + 4) + offs[id]; if (v <= 0xFFFFFFFF) box.writeUInt32BE(v, s2 + 4); }
    });
  });
}
/** A pass-through stream for FFmpeg's fragmented MP4: the moov and every moof fixed up, media data untouched.
    `shift` = the file's start time in seconds (FFprobe's format start_time), taken off every track. */
function retime(shift) {
  let pending = null, mdatLeft = 0, offs = null, raw = false;
  return new Transform({
    transform(chunk, enc, done) {
      if (raw) { this.push(chunk); return done(); }
      const buf = pending ? Buffer.concat([pending, chunk]) : chunk; let p = 0;
      while (p < buf.length) {
        if (mdatLeft > 0) { const n = Math.min(mdatLeft, buf.length - p); this.push(buf.subarray(p, p + n)); p += n; mdatLeft -= n; continue; }
        if (buf.length - p < 16) break;
        let size = buf.readUInt32BE(p), hdr = 8; const type = buf.toString('latin1', p + 4, p + 8);
        if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; }
        if (type === 'mdat' || size === 0) { this.push(buf.subarray(p, p + hdr)); mdatLeft = size === 0 ? Infinity : size - hdr; p += hdr; continue; }
        if (size < hdr || size > 64 * 1048576) { raw = true; this.push(buf.subarray(p)); p = buf.length; break; }   // not what FFmpeg writes: hand it on untouched
        if (buf.length - p < size) break;
        const box = Buffer.from(buf.subarray(p, p + size));
        if (type === 'moov') offs = fromMoov(box, shift); else if (type === 'moof' && offs) patchMoof(box, offs);
        this.push(box); p += size;
      }
      pending = p < buf.length ? Buffer.from(buf.subarray(p)) : null;
      done();
    },
    flush(done) { if (pending) this.push(pending); done(); },
  });
}

module.exports = { retime, _fromMoov: fromMoov };
