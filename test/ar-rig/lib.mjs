// AR検証リグの部品。
// 「正解の分かるカメラ」で机上のマーカーを見た映像を合成し、それを疑似カメラとして
// ヘッドレスChromiumに流して、アプリが描いた位置を正解と比べる。
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import zlib from 'zlib';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

export const RIG_HOME = process.env.AR_RIG_HOME || path.join(os.homedir(), '.cache', 'material-ar-rig');
// 既定はこのリポジトリ。AR_APP_DIR で別の場所（過去の版を取り出したフォルダなど）も検証できる
export const APP_DIR = process.env.AR_APP_DIR ? path.resolve(process.env.AR_APP_DIR) + path.sep : fileURLToPath(new URL('../../', import.meta.url));

// アプリが想定している焦点距離（js/app.js の CAM_F と同じ値。長辺640px換算）
export const CAM_F = 609.4;
const BLACK_RATIO = 0.919;      // hiro.png の中で黒枠が占める割合（CLAUDE.md 参照）

/* ---------- PNG（8bit・非インターレースのみ） ---------- */
export function readPng(src) {
  const buf = Buffer.isBuffer(src) ? src : fs.readFileSync(src);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), ct = buf[25];
  const bpp = { 0: 1, 2: 3, 6: 4 }[ct];
  if (!bpp || buf[24] !== 8 || buf[28] !== 0) { throw new Error('未対応のPNG形式です'); }
  const idat = [];
  for (let pos = 8; pos < buf.length;) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IDAT') { idat.push(buf.subarray(pos + 8, pos + 8 + len)); }
    pos += 12 + len;
    if (type === 'IEND') { break; }
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp, img = Buffer.alloc(h * stride);
  for (let y = 0, rp = 0; y < h; y++, rp += stride) {
    const f = raw[rp++], rs = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = raw[rp + x];
      const l = x >= bpp ? img[rs + x - bpp] : 0, u = y ? img[rs - stride + x] : 0;
      const ul = (y && x >= bpp) ? img[rs - stride + x - bpp] : 0;
      let v = a;
      if (f === 1) { v = a + l; } else if (f === 2) { v = a + u; } else if (f === 3) { v = a + ((l + u) >> 1); }
      else if (f === 4) {
        const p = l + u - ul, pa = Math.abs(p - l), pb = Math.abs(p - u), pc = Math.abs(p - ul);
        v = a + ((pa <= pb && pa <= pc) ? l : (pb <= pc ? u : ul));
      }
      img[rs + x] = v & 255;
    }
  }
  const gray = new Uint8Array(w * h);           // 比較は明るさだけで足りる
  for (let i = 0; i < w * h; i++) {
    gray[i] = bpp === 1 ? img[i] : Math.round(0.299 * img[i * bpp] + 0.587 * img[i * bpp + 1] + 0.114 * img[i * bpp + 2]);
  }
  return { w, h, gray };
}

/* ---------- 正解のカメラと姿勢 ---------- */
/** 正方画素・光学中心が画像中央の理想カメラ。hfovDeg を省くとアプリの想定と同じ画角。 */
export function camera(w, h, hfovDeg) {
  const long = Math.max(w, h);
  const f = hfovDeg ? (long / 2) / Math.tan(hfovDeg * Math.PI / 360) : CAM_F * long / 640;
  return { w, h, f, cx: w / 2, cy: h / 2 };
}

/** 机上のマーカーを仰角 elevDeg（90=真上）・距離 dist（マーカー1辺=1）から見る姿勢。 */
export function pose(elevDeg, dist, yawDeg = 0) {
  const t = (90 - elevDeg) * Math.PI / 180, y = yawDeg * Math.PI / 180;
  const a0 = [1, 0, 0], n = [0, -Math.sin(t), -Math.cos(t)], b0 = [0, Math.cos(t), -Math.sin(t)];
  // マーカーを法線まわりに yaw だけ回す
  const a = a0.map((v, i) => v * Math.cos(y) + b0[i] * Math.sin(y));
  const b = b0.map((v, i) => b0[i] * Math.cos(y) - a0[i] * Math.sin(y));
  return { a, n, b, t: [0, 0, dist] };      // a=マーカーのx, n=y(高さ), b=z(手前)
}

/** マーカー座標(three.jsの向き。単位はマーカー1辺)の点 → 映像の画素 */
export function project(p, P, cam) {
  const X = p[0] * P.a[0] + p[1] * P.n[0] + p[2] * P.b[0] + P.t[0];
  const Y = p[0] * P.a[1] + p[1] * P.n[1] + p[2] * P.b[1] + P.t[1];
  const Z = p[0] * P.a[2] + p[1] * P.n[2] + p[2] * P.b[2] + P.t[2];
  return [cam.f * X / Z + cam.cx, cam.f * Y / Z + cam.cy];
}

/* ---------- 疑似カメラ映像(Y4M) ---------- */
let hiro = null;
export function markerVideo(cam, P, tag) {
  const dir = path.join(RIG_HOME, 'videos');
  const file = path.join(dir, tag + '.y4m');
  if (fs.existsSync(file)) { return file; }
  fs.mkdirSync(dir, { recursive: true });
  hiro = hiro || readPng(path.join(APP_DIR, 'marker', 'hiro.png'));
  const { w: W, h: H } = cam, L = 1 / BLACK_RATIO, SS = 3;
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const tn = dot(P.t, P.n), Y = Buffer.alloc(W * H);
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      let acc = 0;
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) {
          const d = [(u + (i + 0.5) / SS - cam.cx) / cam.f, (v + (j + 0.5) / SS - cam.cy) / cam.f, 1];
          const dn = dot(d, P.n);
          let g = 120;                                             // 机
          if (dn < 0) {
            const lam = tn / dn, q = [lam * d[0] - P.t[0], lam * d[1] - P.t[1], lam * d[2] - P.t[2]];
            const x = dot(q, P.a), z = dot(q, P.b);
            if (Math.abs(x) <= L / 2 && Math.abs(z) <= L / 2) {
              const sx = Math.min(hiro.w - 1, Math.floor((x / L + 0.5) * hiro.w));
              const sy = Math.min(hiro.h - 1, Math.floor((z / L + 0.5) * hiro.h));
              g = hiro.gray[sy * hiro.w + sx];
            } else if (Math.abs(x) <= 1.05 && Math.abs(z) <= 1.45) {
              g = 245;                                             // 紙
            }
          }
          acc += g;
        }
      }
      Y[v * W + u] = Math.round(acc / (SS * SS));
    }
  }
  const UV = Buffer.alloc(Math.ceil(W / 2) * Math.ceil(H / 2), 128);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), Y, UV, UV]);
  const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`)];
  for (let i = 0; i < 6; i++) { parts.push(frame); }
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}

/* ---------- 検証用モデル ---------- */
/** 「作ってみよう！」と同じ作法(Z-up・z=0接地・XY中心)の箱のGLB。寸法はGLB内の数値そのまま。 */
export function boxGlb(sx, sy, sz) {
  const hx = sx / 2, hy = sy / 2;
  const pos = new Float32Array([-hx, -hy, 0, hx, -hy, 0, hx, hy, 0, -hx, hy, 0, -hx, -hy, sz, hx, -hy, sz, hx, hy, sz, -hx, hy, sz]);
  const idx = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
  const pad = (b, fill) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - b.length % 4, fill)]) : b);
  const pb = Buffer.from(pos.buffer), ib = pad(Buffer.from(idx.buffer), 0), bin = Buffer.concat([pb, ib]);
  const json = pad(Buffer.from(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-hx, -hy, 0], max: [hx, hy, sz] },
      { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pb.length }, { buffer: 0, byteOffset: pb.length, byteLength: idx.byteLength }],
    buffers: [{ byteLength: bin.length }]
  })), 0x20);
  const chunk = (type, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.write(type, 4, 'ascii'); return Buffer.concat([h, data]); };
  const body = Buffer.concat([chunk('JSON', json), chunk('BIN\0', bin)]);
  const head = Buffer.alloc(12); head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([head, body]);
}

/* ---------- アプリの配信とブラウザ ---------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.patt': 'text/plain' };
export function serve(dir = APP_DIR) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(dir, rel.endsWith('/') ? rel + 'index.html' : rel);
    if (!file.startsWith(path.resolve(dir)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ url: `http://localhost:${server.address().port}/`, close: () => server.close() })));
}

export async function launch(videoFile) {
  let chromium;
  try {
    ({ chromium } = createRequire(path.join(RIG_HOME, 'x.js'))('playwright-core'));
  } catch (e) {
    throw new Error('検証リグが未準備です。先に test/ar-rig/setup.sh を実行してください。');
  }
  const libs = path.join(RIG_HOME, 'libs', 'usr', 'lib', 'x86_64-linux-gnu');
  return chromium.launch({
    channel: 'chromium',          // ヘッドレス専用版(headless shell)ではなく通常のChromiumを使う
    env: { ...process.env, LD_LIBRARY_PATH: [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') },
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--use-file-for-fake-video-capture=' + videoFile]
  });
}
