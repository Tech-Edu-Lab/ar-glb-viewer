// AR表示の検証。正解の分かる合成映像を疑似カメラとして流し、
// 「アプリが描いた位置」と「正しい位置」を画素単位で比べる。
//
//   準備: test/ar-rig/setup.sh （初回と、~/.cache/material-ar-rig を消したとき）
//   実行: node test/ar-rig/check.mjs            全条件
//         node test/ar-rig/check.mjs 2:1        名前に "2:1" を含む条件だけ
//         SHOTS=/tmp/x node test/ar-rig/check.mjs   画面と撮影写真をPNGで保存
//         AR_URL=https://tech-edu-lab.github.io/ar-glb-viewer/ node test/ar-rig/check.mjs
//                                            手元のファイルではなく、公開サイトそのものを検査
//
// 実機のカメラ・照明・印刷精度は含まれない。合格しても「実機で動いた」ことにはならない。
import fs from 'fs';
import path from 'path';
import { camera, pose, project, markerVideo, boxGlb, serve, launch, readPng } from './lib.mjs';

// 検証用の箱。GLB内の数値 15×10×22 → 既定の10倍補正で 150×100×220mm（マーカーは100mm）
const BOX = [15, 10, 22];
const CORNERS = [];                                   // マーカー座標での8つの角（単位: マーカー1辺）
for (const y of [0, BOX[2] / 10]) for (const x of [-1, 1]) for (const z of [-1, 1]) {
  CORNERS.push([x * BOX[0] / 20, y, z * BOX[1] / 20]);
}
const MARKER = [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5], [0, 0, 0]];

// 合格の基準（映像の長辺を1280pxに換算した値）
// photo は「撮影写真と画面の明るさの差」。画面の拡大率に端数があると、ブラウザの画面合成と
// 写真の合成で画素の丸め方が半画素ほど違うため、その条件だけ基準をゆるめる。
const LIMIT = { sizeMm: 1, plane: 8, base: 10, top: 16, heightLo: 0.97, heightHi: 1.03, photo: 12, photoFractionalDpr: 30 };

const SCENARIOS = [
  // 実機に近い条件: 画面はアドレスバー等で16:9にならない
  { name: '実機相当 画面2:1 / 映像16:9 / 仰角25°', win: [1089, 544], stream: [1280, 720], elev: 25, dist: 6.5 },
  { name: '画面2:1 / 映像16:9 / 仰角45°', win: [1089, 544], stream: [1280, 720], elev: 45, dist: 6 },
  { name: '画面2:1 / 映像16:9 / 仰角70° 斜め向き', win: [1089, 544], stream: [1280, 720], elev: 70, dist: 6, yaw: 30 },
  { name: '画面2:1 / 映像16:9 / 真上', win: [1089, 544], stream: [1280, 720], elev: 90, dist: 6 },
  { name: '画面16:9 / 映像16:9 / 仰角45°', win: [1366, 768], stream: [1280, 720], elev: 45, dist: 6 },
  { name: '画面4:3（映像の左右が切れる） / 映像16:9', win: [1024, 768], stream: [1280, 720], elev: 45, dist: 6 },
  { name: '画面2:1 拡大率1.25 / 映像16:9', win: [1093, 546], dpr: 1.25, stream: [1280, 720], elev: 35, dist: 6 },
  { name: '縦長の窓 / 映像16:9', win: [500, 800], stream: [1280, 720], elev: 45, dist: 8 },
  // カメラが16:9を出せない端末
  { name: '画面2:1 / 映像4:3', win: [1089, 544], stream: [640, 480], elev: 35, dist: 6 },
  { name: '画面16:9 / 映像4:3', win: [1366, 768], stream: [640, 480], elev: 60, dist: 6 },
  // 縦向きの映像（タブレット持ちで縦にしたとき）
  // （疑似カメラは「幅1280・高さ720を希望」に対し、それを超える分を切り落とす。
  //   縦長のまま届かせるには、元の映像を希望より小さくしておく必要がある）
  { name: '縦画面 / 縦向き映像9:16', win: [600, 960], stream: [360, 640], elev: 40, dist: 7 },
  { name: '横画面 / 縦向き映像9:16', win: [1089, 544], stream: [360, 640], elev: 55, dist: 7 },
  // やり直しを伴う操作のあとも正しいか
  {
    name: 'もどる→はじめる を3回くり返したあと', win: [1089, 544], stream: [1280, 720], elev: 35, dist: 6,
    before: async (page) => {
      for (let i = 0; i < 3; i++) {
        await page.click('#backBtn');
        await page.waitForFunction(() => document.getElementById('home').classList.contains('is-active'));
        // ホームに戻ったら、カメラは止まり、AR.js が body に書いた寸法も残っていないこと
        // （窓の大きさが変わっても、止めたはずの AR.js が書き戻さないこと）
        const left = await page.evaluate(() => {
          window.dispatchEvent(new Event('resize'));
          return { style: (document.body.getAttribute('style') || '').trim(), videos: document.querySelectorAll('video').length, scenes: document.querySelectorAll('a-scene').length };
        });
        if (left.style || left.videos || left.scenes) { throw new Error('もどった後に残っているもの: ' + JSON.stringify(left)); }
        await page.click('#startBtn');
        await page.waitForTimeout(1500);
      }
    }
  },
  {
    name: 'はじめた直後に もどる（映像が後から届く）', win: [1089, 544], stream: [1280, 720], elev: 35, dist: 6,
    before: async (page) => {
      await page.click('#backBtn');
      for (let i = 0; i < 4; i++) {
        await page.click('#startBtn');
        await page.click('#backBtn');                  // AR画面が出た瞬間に押される
      }
      await page.waitForTimeout(3000);
      const left = await page.evaluate(() => ({ videos: document.querySelectorAll('video').length, scenes: document.querySelectorAll('a-scene').length }));
      if (left.videos || left.scenes) { throw new Error('もどった後にカメラ映像が残っている: ' + JSON.stringify(left)); }
      await page.click('#startBtn');
    }
  },
  {
    name: '表示中に窓の大きさを変える（16:9 → 2:1）', win: [1366, 768], stream: [1280, 720], elev: 35, dist: 6,
    before: async (page) => { await page.setViewportSize({ width: 1089, height: 544 }); await page.waitForTimeout(800); }
  },
  {
    name: '途中で映像の縦横比が変わる（16:9→4:3）→ 自動でやり直す', win: [1089, 544], stream: [1280, 720], elev: 35, dist: 6,
    before: async (page) => {
      await page.evaluate(() => document.getElementById('arjs-video').srcObject.getVideoTracks()[0].applyConstraints({ width: 640, height: 480 }));
      await page.waitForTimeout(4000);
    }
  },
  // 参考: カメラの画角がアプリの想定(55°)と違う場合の影響。合否には含めない
  { name: '参考 画角70°のカメラ / 画面2:1', win: [1089, 544], stream: [1280, 720], elev: 30, dist: 6.5, hfov: 70, info: true },
];

const f1 = (n) => n.toFixed(1);
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

async function measure(page) {
  return page.evaluate(({ MARKER }) => {
    const mk = document.getElementById('mk'), model = document.getElementById('model');
    const scene = document.querySelector('a-scene'), v = document.getElementById('arjs-video');
    if (!mk || !scene || !scene.camera || !v || !v.videoWidth || !mk.object3D.visible) { return null; }
    const T = AFRAME.THREE;
    const cr = scene.renderer.domElement.getBoundingClientRect(), vr = v.getBoundingClientRect();
    const toStream = (p) => {                  // NDC → ページ上の位置 → 映像の画素
      const px = cr.left + (p.x + 1) / 2 * cr.width, py = cr.top + (1 - p.y) / 2 * cr.height;
      return [(px - vr.left) / vr.width * v.videoWidth, (py - vr.top) / vr.height * v.videoHeight];
    };
    const marker = MARKER.map((m) => toStream(mk.object3D.localToWorld(new T.Vector3(m[0], m[1], m[2])).project(scene.camera)));
    const verts = [];
    model.object3D.traverse((o) => {
      if (!o.isMesh) { return; }
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const w = o.localToWorld(new T.Vector3().fromBufferAttribute(pos, i));
        const l = mk.object3D.worldToLocal(w.clone());            // マーカー座標での位置（単位: マーカー1辺）
        verts.push(toStream(w.project(scene.camera)).concat([l.x, l.y, l.z]));
      }
    });
    const arc = scene.systems.arjs._arSession.arContext.arController;
    const r = (b) => [b.left, b.top, b.width, b.height].map((n) => Math.round(n * 10) / 10);
    return {
      marker, verts, video: [v.videoWidth, v.videoHeight], videoRect: r(vr), canvasRect: r(cr),
      det: arc ? [arc.canvas.width, arc.canvas.height, arc.orientation] : null,
      buffer: [scene.renderer.domElement.width, scene.renderer.domElement.height]
    };
  }, { MARKER });
}

/** 撮影した写真が「画面に見えていたもの」と一致するか（4x4に縮めた明るさの最大差） */
function photoDiff(a, b) {
  // 画面の拡大率に端数があると、画素数は丸め方で1だけ違うことがある
  if (Math.abs(a.w - b.w) > 1 || Math.abs(a.h - b.h) > 1) { return { size: false, a, b }; }
  const w = Math.min(a.w, b.w), h = Math.min(a.h, b.h);
  let max = 0;
  for (let y = 0; y + 4 <= h; y += 4) {
    for (let x = 0; x + 4 <= w; x += 4) {
      let sa = 0, sb = 0;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { sa += a.gray[(y + j) * a.w + x + i]; sb += b.gray[(y + j) * b.w + x + i]; }
      max = Math.max(max, Math.abs(sa - sb) / 16);
    }
  }
  return { size: true, max };
}

/** マーカーが見つかって姿勢が落ち着くまで待ち、測定値を返す */
async function settle(page) {
  let m = null;
  for (let i = 0; i < 80 && !m; i++) { await page.waitForTimeout(250); m = await measure(page); }
  if (!m) { return null; }
  await page.waitForTimeout(2500);                      // 平滑化が落ち着くのを待つ
  return measure(page);
}

async function run(sc, base, glb) {
  const cam = camera(sc.stream[0], sc.stream[1], sc.hfov), P = pose(sc.elev, sc.dist, sc.yaw || 0);
  const tag = [sc.stream.join('x'), 'e' + sc.elev, 'd' + sc.dist, 'y' + (sc.yaw || 0), 'f' + Math.round(cam.f)].join('_');
  const browser = await launch(markerVideo(cam, P, tag));
  const out = { name: sc.name, problems: [] };
  try {
    const page = await browser.newPage({ viewport: { width: sc.win[0], height: sc.win[1] }, deviceScaleFactor: sc.dpr || 1 });
    page.on('pageerror', (e) => out.problems.push('ページ内エラー: ' + e.message));
    await page.goto(base, { waitUntil: 'load' });
    await page.setInputFiles('#glbInput', { name: 'box.glb', mimeType: 'model/gltf-binary', buffer: glb });
    await page.waitForFunction(() => !document.getElementById('startBtn').disabled);
    await page.click('#startBtn');
    let m = await settle(page);
    if (!m) { out.problems.push('マーカーを検出できませんでした'); return out; }
    if (sc.before) {                                    // 測定の前に、やり直しを伴う操作をはさむ
      try { await sc.before(page); } catch (e) { out.problems.push(e.message); return out; }
      m = await settle(page);
      if (!m) { out.problems.push('操作のあと、マーカーを検出できませんでした'); return out; }
    }
    Object.assign(out, { video: m.video, videoRect: m.videoRect, canvasRect: m.canvasRect, det: m.det, buffer: m.buffer });

    const k = 1280 / Math.max(m.video[0], m.video[1]);  // 長辺1280px換算
    const tr = (p) => project(p, P, cam);
    out.plane = Math.max(...MARKER.map((p, i) => dist2(m.marker[i], tr(p)))) * k;
    // モデルの各頂点を、マーカー座標で最も近い「あるべき角」に対応づける。
    // その距離は、モデルが正しい大きさ・位置でマーカーに載っていれば0になる（投影とは無関係）。
    const d3 = (v, c) => Math.hypot(v[2] - c[0], v[3] - c[1], v[4] - c[2]);
    const hit = CORNERS.map((c) => m.verts.reduce((b, v) => (d3(v, c) < d3(b, c) ? v : b)));
    out.sizeMm = Math.max(...CORNERS.map((c, i) => d3(hit[i], c))) * 100;
    const truth = CORNERS.map(tr);
    const err = (i) => dist2(hit[i], truth[i]) * k;
    out.base = Math.max(err(0), err(1), err(2), err(3));
    out.top = Math.max(err(4), err(5), err(6), err(7));
    const ratios = [0, 1, 2, 3].map((i) => dist2(hit[i + 4], hit[i]) / dist2(truth[i + 4], truth[i]));
    out.height = [Math.min(...ratios), Math.max(...ratios)];

    // 撮影写真 = 画面に見えていたもの か
    await page.addStyleTag({ content: '#hud,#flash{visibility:hidden !important}' });
    const shot = await page.screenshot();
    await page.evaluate(() => document.getElementById('shutter').click());
    await page.waitForFunction(() => document.getElementById('shot').classList.contains('is-active') && document.getElementById('shotImg').naturalWidth > 0);
    const b64 = await page.evaluate(async () => {
      const buf = new Uint8Array(await (await fetch(document.getElementById('shotImg').src)).arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i++) { s += String.fromCharCode(buf[i]); }
      return btoa(s);
    });
    const photo = Buffer.from(b64, 'base64');
    out.photo = photoDiff(readPng(shot), readPng(photo));
    if (process.env.SHOTS) {
      fs.mkdirSync(process.env.SHOTS, { recursive: true });
      const stem = path.join(process.env.SHOTS, sc.name.replace(/[^0-9A-Za-z぀-ヿ一-鿿]+/g, '_'));
      fs.writeFileSync(stem + '_画面.png', shot); fs.writeFileSync(stem + '_写真.png', photo);
    }

    if (out.sizeMm > LIMIT.sizeMm) { out.problems.push(`モデルの大きさ・置き場所が ${f1(out.sizeMm)}mm ずれている`); }
    if (out.plane > LIMIT.plane) { out.problems.push(`マーカー面のずれ ${f1(out.plane)}px > ${LIMIT.plane}`); }
    if (out.base > LIMIT.base) { out.problems.push(`モデル底面のずれ ${f1(out.base)}px > ${LIMIT.base}`); }
    if (out.top > LIMIT.top) { out.problems.push(`モデル上面のずれ ${f1(out.top)}px > ${LIMIT.top}`); }
    if (out.height[0] < LIMIT.heightLo || out.height[1] > LIMIT.heightHi) { out.problems.push(`高さの見え方 ${(out.height[0] * 100).toFixed(0)}〜${(out.height[1] * 100).toFixed(0)}%`); }
    if (!out.photo.size) { out.problems.push(`写真の大きさ ${out.photo.b.w}x${out.photo.b.h} が画面 ${out.photo.a.w}x${out.photo.a.h} と違う`); }
    else if (out.photo.max > (Number.isInteger(sc.dpr || 1) ? LIMIT.photo : LIMIT.photoFractionalDpr)) { out.problems.push(`写真が画面と一致しない（差 ${f1(out.photo.max)}）`); }
  } finally {
    await browser.close();
  }
  return out;
}

const filter = process.argv[2];
const site = process.env.AR_URL ? { url: process.env.AR_URL, close() {} } : await serve();
const glb = boxGlb(...BOX);
let failed = 0;
for (const sc of SCENARIOS) {
  if (filter && !sc.name.includes(filter)) { continue; }
  const r = await run(sc, site.url, glb);
  const ok = r.problems.length === 0;
  if (!ok && !sc.info) { failed++; }
  console.log(`${sc.info ? '（参考）' : ok ? '✅' : '❌'} ${r.name}`);
  if (r.video) {
    console.log(`     映像 ${r.video.join('x')} / 検出 ${r.det ? r.det.join(' ') : '-'} / 映像枠 [${r.videoRect}] / 3D枠 [${r.canvasRect}]`);
    console.log(`     寸法ずれ ${f1(r.sizeMm)}mm  マーカー面 ${f1(r.plane)}px  底面 ${f1(r.base)}px  上面 ${f1(r.top)}px  高さ ${(r.height[0] * 100).toFixed(0)}〜${(r.height[1] * 100).toFixed(0)}%` +
      (r.photo ? `  写真 ${r.photo.size ? '差' + f1(r.photo.max) : '大きさ不一致'}` : ''));
  }
  r.problems.forEach((p) => console.log('     → ' + p));
}
site.close();
console.log(failed ? `\n===== 不合格 ${failed} 件 =====` : '\n===== すべて合格 =====');
process.exit(failed ? 1 : 0);
