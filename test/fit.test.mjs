import * as THREE from './three.module.js';
import fs from 'fs';

// ---- app.js から正規化ロジックを実物のまま抜き出して評価する ----
const src = fs.readFileSync('/home/tech-edu-lab/projects/ar-glb-viewer/js/app.js', 'utf8');
const start = src.indexOf('function measureLocal');
const end   = src.indexOf('/**\n   * マテリアルの安全化');
if (start < 0 || end < 0) { throw new Error('関数の抽出に失敗'); }
const body = src.slice(start, end);
const { measureLocal, detectUp, fitModel } =
  new Function('THREE', body + '\nreturn { measureLocal, detectUp, fitModel };')(THREE);

// ---- テスト用モデル生成 ----
function boxModel(sx, sy, sz, cx, cy, cz) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate(cx, cy, cz);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
  const root = new THREE.Group();
  root.add(m);
  return root;
}

let pass = 0, fail = 0;
const r3 = (n) => Math.round(n * 1000) / 1000;

function check(label, cond, got) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}  → ${got}`); }
}

function run(name, model, opts, expect) {
  console.log(`\n■ ${name}`);
  const pivot = new THREE.Group();
  pivot.add(model);
  const fit = fitModel(model, opts);
  check(`上方向の判定 = ${expect.up}`, fit.detectedUp === expect.up, fit.detectedUp);

  pivot.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(model);
  const s = b.getSize(new THREE.Vector3());
  const c = b.getCenter(new THREE.Vector3());
  const max = Math.max(s.x, s.y, s.z);

  check(`最大辺 = ${opts.size}`, Math.abs(max - opts.size) < 1e-6, r3(max));
  check('底面が y=0 に接地', Math.abs(b.min.y - (opts.lift || 0)) < 1e-6, r3(b.min.y));
  check('水平方向が原点中心', Math.abs(c.x) < 1e-6 && Math.abs(c.z) < 1e-6, `x=${r3(c.x)} z=${r3(c.z)}`);
  check(`高さ = ${expect.h}`, Math.abs(s.y - expect.h) < 1e-4, r3(s.y));
  console.log(`     寸法: ${r3(s.x)} × ${r3(s.y)} × ${r3(s.z)}`);
}

// 1) 「作ってみよう!」想定: Z-up、z=0接地、XY中心、mm単位
//    幅150 × 奥行200 × 高さ180 → 最大辺200を1.0にするので高さは0.9
run('Z-up CAD (作ってみよう!/本立て 150×200×180mm)',
    boxModel(150, 200, 180, 0, 0, 90), { size: 1, lift: 0, up: 'auto' },
    { up: 'z', h: 180 / 200 });

// 2) Tinkercad想定: Y-up、y=0接地、XZ中心
run('Y-up (Tinkercad 150×180×200)',
    boxModel(150, 180, 200, 0, 90, 0), { size: 1, lift: 0, up: 'auto' },
    { up: 'y', h: 180 / 200 });

// 3) 極端に小さいモデル(単位がmで書き出された場合)
run('Y-up かつ極小 (0.15×0.18×0.20)',
    boxModel(0.15, 0.18, 0.20, 0, 0.09, 0), { size: 1, lift: 0, up: 'auto' },
    { up: 'y', h: 180 / 200 });

// 4) 手動でZ-up指定を上書き(自動判定が外れた場合の救済)
console.log('\n■ 手動上書き: Y-upモデルに up:"z" を強制');
{
  const model = boxModel(150, 180, 200, 0, 90, 0);
  const pivot = new THREE.Group(); pivot.add(model);
  const fit = fitModel(model, { size: 1, lift: 0, up: 'z' });
  check('使用した向き = z', fit.usedUp === 'z', fit.usedUp);
  check('X軸まわりに-90度回転している', Math.abs(model.rotation.x + Math.PI / 2) < 1e-9, model.rotation.x);
}

// 5) 浮かせる
console.log('\n■ lift = 0.3');
{
  const model = boxModel(150, 200, 180, 0, 0, 90);
  const pivot = new THREE.Group(); pivot.add(model);
  fitModel(model, { size: 1, lift: 0.3, up: 'auto' });
  pivot.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(model);
  check('底面が y=0.3', Math.abs(b.min.y - 0.3) < 1e-6, r3(b.min.y));
}

// 6) マーカーが動いてもモデルの正規化結果が変わらないこと(measureLocalの要件)
console.log('\n■ 親(マーカー)が回転・移動しても結果が不変');
{
  const model = boxModel(150, 200, 180, 0, 0, 90);
  const marker = new THREE.Group(); marker.add(model);
  fitModel(model, { size: 1, lift: 0, up: 'auto' });
  const before = model.scale.x;
  const posBefore = model.position.clone();

  marker.position.set(3, -2, 7);
  marker.rotation.set(0.9, -1.3, 0.4);
  marker.scale.setScalar(2.5);
  marker.updateMatrixWorld(true);
  fitModel(model, { size: 1, lift: 0, up: 'auto' });

  check('スケールが不変', Math.abs(model.scale.x - before) < 1e-12, model.scale.x);
  check('位置が不変', model.position.distanceTo(posBefore) < 1e-12, model.position.toArray().map(r3));
}

console.log(`\n===== 合格 ${pass} / 失敗 ${fail} =====`);
process.exit(fail ? 1 : 0);
