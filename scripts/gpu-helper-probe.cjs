'use strict';
// The helper alone on the graphics chip, no window: `node scripts/gpu-helper-probe.cjs <film> [rounds]`. Starts
// build/mpv/<platform>/nebula-mpv the way mpv-host.js does (NEBULA_MPV_GPU=1), asks for a 640x360 picture, plays a still
// film of four colours (red | green over blue | white) and reads the helper's own trace of what its buffer holds
// (NEBULA_GPU_TRACE: a pixel in the top-left quarter). A round is right when that pixel is red. Tells whether a wrong picture
// is made in the helper itself or only on its way into a window (scripts/gpu-check.cjs).
const path = require('path'), cp = require('child_process'), net = require('net'), os = require('os'), fs = require('fs');
const WIN = process.platform === 'win32';
const dir = path.join(__dirname, '..', 'build', 'mpv', WIN ? 'win' : 'linux');
const helper = path.join(dir, WIN ? 'nebula-mpv.exe' : 'nebula-mpv');
const lib = WIN ? path.join(dir, 'libmpv-2.dll') : ['libmpv.so.2', 'libmpv.so.1', path.join(dir, 'libmpv.so.1')].join('|');
const film = path.resolve(process.argv[2] || ''), rounds = Number(process.argv[3]) || 10;
const opts = String(process.env.NEBULA_MPV_TEST_OPTS || '').split(';').filter((kv) => kv.includes('='));

function round(n) {
  return new Promise((done) => {
    const ipc = WIN ? '\\\\.\\pipe\\nebula-probe-' + process.pid + '-' + n : path.join(os.tmpdir(), 'nebula-probe-' + process.pid + '-' + n);
    const env = Object.assign({}, process.env, { NEBULA_MPV_GPU: '1', NEBULA_GPU_TRACE: '1', NEBULA_ANGLE_DIR: path.join(dir, 'angle'), NEBULA_MPV_TOKEN: '0123456789abcdef0123' });
    const p = cp.spawn(helper, [ipc, '1920', '1080', String(process.pid), '-', 'null', lib, 'ao=null', 'keep-open=yes', 'msg-level=all=warn'].concat(opts),
      { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '', px = [], gpu = false, sock = null;
    const end = (why) => { try { sock && sock.destroy(); } catch (e) {} try { p.kill(); } catch (e) {} done({ n, why, gpu, px }); };
    const timer = setTimeout(() => end('time'), 12000);
    p.stderr.on('data', (d) => {
      err += d;
      let i;
      while ((i = err.indexOf('\n')) >= 0) {
        const l = err.slice(0, i); err = err.slice(i + 1);
        const m = /drawn (\d+) (\d+) (\d+)/.exec(l);
        if (m) { px.push([+m[1], +m[2], +m[3]]); if (px.length >= 3) { clearTimeout(timer); end('ok'); } }
        else if (/graphics chip:/.test(l)) process.stdout.write('  ' + l.trim() + '\n');
      }
    });
    p.stdout.on('data', (d) => {
      out += d;
      const m = /READY (\d+)( gpu)?/.exec(out);
      if (m && !sock) {
        gpu = !!m[2];
        p.stdin.write('S 640 360\nV 1\n');
        const go = (t) => {
          sock = net.createConnection(ipc);
          sock.on('connect', () => sock.write(JSON.stringify({ command: ['loadfile', film] }) + '\n'));
          sock.on('error', () => { sock = null; if (t < 40) setTimeout(() => go(t + 1), 100); });
        };
        go(0);
      }
    });
    p.on('exit', () => { clearTimeout(timer); if (px.length < 3) end('the helper left'); });
  });
}

(async () => {
  if (!fs.existsSync(film)) { console.log('no film'); process.exit(2); }
  let right = 0;
  for (let n = 1; n <= rounds; n++) {
    const r = await round(n), last = r.px[r.px.length - 1] || [];
    const ok = r.gpu && last.length === 3 && last[0] > 200 && last[1] < 50 && last[2] < 50;
    if (ok) right++;
    console.log('round ' + n + ': ' + (ok ? 'right' : 'WRONG') + ' (gpu ' + r.gpu + ', ' + r.why + ', ' + JSON.stringify(r.px) + ')');
  }
  console.log(right + '/' + rounds + ' right');
  process.exit(right === rounds ? 0 : 1);
})();
