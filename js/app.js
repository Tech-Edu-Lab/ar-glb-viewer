/* ============================================================
   3DモデルARビューア
   A-Frame 1.3.0 (three.js r137) + AR.js 3.4.5 / マーカー型

   設計の要点:
     読み込んだGLBを「必ず正しい向き・大きさ」に自動正規化してから
     マーカー上に置く。生徒に数値を選ばせない。
   ============================================================ */
(function () {
  'use strict';

  var THREE = AFRAME.THREE;

  /* ---------- 定数 ---------- */
  var CAM_PARA   = 'data/camera_para.dat';          // ARToolKit カメラ校正（同梱）
  var PATT_HIRO  = 'marker/pattern-hiro.patt';      // Hiroマーカー（同梱）
  // カメラ取り込み解像度と、マーカー検出に使う内部キャンバスの解像度。
  // この2つの「縦横比」は必ず一致させること。
  // AR.js は映像を検出キャンバスへ引き伸ばして流し込むため、比率がずれると
  // マーカーが歪んで認識され、モデルがマーカーからずれて表示される。
  // 1280x720 は webcam でほぼ確実に使える解像度。検出は 1/2 の 640x360 で足りる。
  var SRC_W      = 1280;
  var SRC_H      = 720;
  var DET_W      = 640;
  var DET_H      = 360;

  // マーカーの黒い枠1辺の実寸(m)。marker/print.html は必ずこの大きさで印刷される前提。
  // hiro.png(2000x2000px)は黒枠の外側の四辺それぞれに、画像1辺の4.05%(81px)の
  // 白い余白を内蔵しており、黒枠は画像の91.9%(1838/2000px)にしかならない。
  // print.html側で画像の表示サイズを108.8mmにすることで、印刷した黒枠がちょうど
  // 100mmになるよう調整してある。印刷レイアウトを変えたら要更新。
  var MARKER_SIZE_M = 0.1;
  // ホーム画面プレビューの基準視野(m)。モデルがこれより小さいときはこの広さのまま映す
  // ことで、実際より小さいモデルが「小さいまま」見えるようにする(カメラを寄せて誤魔化さない)。
  var PREVIEW_BASE_VIEW_M = 0.3;
  // CADの数値(mm)をA-Frameの単位(m)に変換する係数。「作ってみよう！」はmmでエクスポートする前提。
  var MM_TO_M = 0.001;
  // 【重要・実機テストで判明した落とし穴】
  // 同梱のAR.jsビルドは <a-marker size="..."> を実装内部で一切参照しない(死んでいる属性)。
  // ARToolKitの姿勢行列は常に「マーカー1辺の実寸＝1」という相対座標系で返ってくるため、
  // 実際のメートル数値をそのまま置くと、マーカーの実寸(MARKER_SIZE_M)ぶん余計に縮んで見える。
  // (実機カメラ映像の代わりに合成マーカー映像を流し込み、a-markerのmatrixWorldを
  //  直接読み取って確認した。size属性の値を変えても行列が一切変化しないことを確認済み。)
  // そのため、AR画面用のスケールだけは「実メートル ÷ マーカーの実寸」に変換して、
  // ARToolKitの相対座標系に合わせる。ホーム画面プレビューは独立したthree.jsシーンで
  // この変換は不要(素直に実メートルでよい)なので、fitModelのopts.arUnitScaleでのみ渡す。
  var AR_UNIT_SCALE = 1 / MARKER_SIZE_M;

  /* ---------- 状態 ---------- */
  var state = {
    glbUrl: null, glbName: '',
    pattUrl: null, pattName: '',
    markerMode: 'hiro',
    size: 1.0, lift: 0, up: 'auto', spin: false, scale10x: false,
    deviceId: '',
    sceneEl: null,
    shotBlob: null,
    curFile: null, curStats: null
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ============================================================
     1. ジオメトリ正規化 — このアプリの中核
     ============================================================ */

  /**
   * obj の「親空間での」軸平行バウンディングボックスを求める。
   * Box3.setFromObject はワールド空間を返すため、マーカーが動くと
   * 値が変わってしまう。一時的に単位行列の親へ付け替えて計測する。
   */
  function measureLocal(obj) {
    var parent = obj.parent;
    var scratch = new THREE.Object3D();
    scratch.add(obj);                       // 元の親からは自動的に外れる
    scratch.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(obj);
    if (parent) { parent.add(obj); } else { scratch.remove(obj); }
    return box;
  }

  /**
   * 上方向がYかZかを推定する。
   *   glTF規格はY-up。しかし「作ってみよう！」やTinkercad等のCADはZ-upで、
   *   three.jsのGLTFExporterは軸変換をしないためZ-upのまま書き出される
   *   （＝ARで寝てしまう）。
   *   判定材料:
   *     ・その軸の最小値が0 ＝ その平面に接地している
   *     ・他の2軸の中心が0付近 ＝ その2軸が水平面
   */
  function detectUp(box, maxDim) {
    var tol = maxDim * 0.03;
    var c = box.getCenter(new THREE.Vector3());
    var scoreY = 0, scoreZ = 0;
    if (Math.abs(box.min.y) < tol) { scoreY += 2; }
    if (Math.abs(box.min.z) < tol) { scoreZ += 2; }
    if (Math.abs(c.z) < tol) { scoreY += 1; }
    if (Math.abs(c.y) < tol) { scoreZ += 1; }
    return scoreZ > scoreY ? 'z' : 'y';
  }

  /**
   * モデルを ①直立 ②中央寄せ＋接地 ③指定サイズ に正規化する。
   * @return {object|null} 診断情報
   */
  function fitModel(model, opts) {
    model.rotation.set(0, 0, 0);
    model.scale.set(1, 1, 1);
    model.position.set(0, 0, 0);

    var b0 = measureLocal(model);
    if (b0.isEmpty()) { return null; }
    var s0 = b0.getSize(new THREE.Vector3());
    var max0 = Math.max(s0.x, s0.y, s0.z);
    if (!(max0 > 0)) { return null; }

    // ① 直立させる
    var detected = detectUp(b0, max0);
    var up = (opts.up === 'auto') ? detected : opts.up;
    if (up === 'z') { model.rotation.x = -Math.PI / 2; }

    // ② 実寸表示：CADの数値(mm想定)をそのままメートルへ変換する。
    //    「作ってみよう！」が画面表示の1/10の数値で書き出すことがあるため、
    //    その補正(×10, opts.tenX)と、手動の微調整(opts.size)を掛け合わせる。
    //    opts.arUnitScale は AR画面だけに必要な追加変換（下記参照）。
    //    プレビューでは渡さない＝1のまま＝素直に実メートル。
    var realScale = MM_TO_M * (opts.tenX ? 10 : 1) * (opts.size || 1);
    var scale = realScale * (opts.arUnitScale || 1);
    model.scale.setScalar(scale);

    // ③ 水平方向は中央、垂直方向は底面をマーカー面(y=0)へ
    var b2 = measureLocal(model);
    var c2 = b2.getCenter(new THREE.Vector3());
    model.position.x = -c2.x;
    model.position.z = -c2.z;
    model.position.y = -b2.min.y + (opts.lift || 0);

    return { detectedUp: detected, usedUp: up, srcSize: s0, srcMax: max0, scale: realScale };
  }

  /**
   * マテリアルの安全化。
   *   ・法線欠落 → 再計算（threecsgのブーリアン結果でよく起きる）
   *   ・面の裏表 → DoubleSide（法線反転で面が消えるのを防ぐ）
   *   ・metalness=1 の既定PBR材質は環境マップ無しで真っ黒になる → 金属度を下げる
   */
  function prepareMaterials(root) {
    root.traverse(function (o) {
      if (!o.isMesh) { return; }
      if (o.geometry && !o.geometry.attributes.normal) {
        o.geometry.computeVertexNormals();
      }
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(function (m) {
        if (!m) { return; }
        m.side = THREE.DoubleSide;
        if (m.metalness !== undefined) { m.metalness = Math.min(m.metalness, 0.05); }
        if (m.roughness !== undefined) { m.roughness = Math.max(m.roughness, 0.7); }
        if (m.transparent && m.opacity < 0.05) { m.transparent = false; m.opacity = 1; }
        if (m.color && (m.color.r + m.color.g + m.color.b) < 0.05) { m.color.setHex(0xbfc6cc); }
        m.needsUpdate = true;
      });
    });
  }

  /** 三角形数などの統計 */
  function collectStats(root) {
    var st = { tri: 0, vert: 0, mesh: 0, noNormal: 0, mat: 0 };
    var seen = [];
    root.traverse(function (o) {
      if (!o.isMesh || !o.geometry) { return; }
      st.mesh++;
      var g = o.geometry, pos = g.attributes.position;
      if (pos) { st.vert += pos.count; }
      st.tri += g.index ? g.index.count / 3 : (pos ? pos.count / 3 : 0);
      if (!g.attributes.normal) { st.noNormal++; }
      var ms = Array.isArray(o.material) ? o.material : [o.material];
      ms.forEach(function (m) { if (m && seen.indexOf(m) < 0) { seen.push(m); } });
    });
    st.tri = Math.round(st.tri);
    st.mat = seen.length;
    return st;
  }

  /** 標準的な照明（陰影は簡易。CADの見た目を厳密再現はしない方針） */
  function addLights(scene) {
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa3ab, 0.45));
    var dir = new THREE.DirectionalLight(0xffffff, 0.55);
    dir.position.set(1, 2, 1);
    scene.add(dir);
  }

  /* ============================================================
     2. ホーム画面の3Dプレビュー
     （マーカーを印刷しなくても向き・大きさを確認できる）
     ============================================================ */
  var pv = { on: false, model: null, drag: null, yaw: 0.6, pitch: 0.5 };

  function initPreview() {
    if (pv.renderer) { return; }
    var cv = $('preview');
    pv.renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
    pv.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    pv.scene = new THREE.Scene();
    pv.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    addLights(pv.scene);

    // マーカーの実際の大きさ（黒枠1辺）を示す枠
    var grid = new THREE.GridHelper(MARKER_SIZE_M, 4, 0x8c98a4, 0xc4ccd4);
    pv.scene.add(grid);

    pv.pivot = new THREE.Group();
    pv.scene.add(pv.pivot);

    cv.addEventListener('pointerdown', function (e) {
      pv.drag = { x: e.clientX, y: e.clientY };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', function (e) {
      if (!pv.drag) { return; }
      pv.yaw   += (e.clientX - pv.drag.x) * 0.01;
      pv.pitch += (e.clientY - pv.drag.y) * 0.006;
      pv.pitch = Math.max(0.05, Math.min(1.4, pv.pitch));
      pv.drag = { x: e.clientX, y: e.clientY };
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      cv.addEventListener(ev, function () { pv.drag = null; });
    });

    (function loop() {
      requestAnimationFrame(loop);
      if (!pv.on || !$('home').classList.contains('is-active')) { return; }
      var cv2 = pv.renderer.domElement;
      var w = cv2.clientWidth, h = cv2.clientHeight;
      if (w && h && (cv2.width !== w * pv.renderer.getPixelRatio() || cv2.height !== h * pv.renderer.getPixelRatio())) {
        pv.renderer.setSize(w, h, false);
        pv.camera.aspect = w / h;
        pv.camera.updateProjectionMatrix();
      }
      // 実寸表示になったため、モデルが基準視野より大きいときだけカメラを引く。
      // 小さいモデルでもカメラを寄せて大きく見せることはしない
      // (寄せてしまうと「実際は小さい」ことが画面上で分からなくなるため)。
      var base = pv.viewSize || PREVIEW_BASE_VIEW_M;
      var r = base * 2.4;
      pv.camera.position.set(
        Math.sin(pv.yaw) * Math.cos(pv.pitch) * r,
        Math.sin(pv.pitch) * r,
        Math.cos(pv.yaw) * Math.cos(pv.pitch) * r
      );
      pv.camera.lookAt(0, base * 0.35, 0);
      pv.renderer.render(pv.scene, pv.camera);
    })();
  }

  function previewApply() {
    if (!pv.model) { return; }
    var fit = fitModel(pv.model, { size: state.size, lift: state.lift, up: state.up, tenX: state.scale10x });
    if (fit) { pv.viewSize = Math.max(fit.srcMax * fit.scale * 1.3, PREVIEW_BASE_VIEW_M); }
    if (state.curFile) { showInfo(state.curFile, state.curStats, fit); }
  }

  /* ============================================================
     3. GLB の読み込みと診断
     ============================================================ */
  function loadGlb(file) {
    var url = URL.createObjectURL(file);
    $('glbError').classList.add('is-hidden');

    new THREE.GLTFLoader().load(url, function (gltf) {
      if (state.glbUrl) { URL.revokeObjectURL(state.glbUrl); }
      state.glbUrl = url;
      state.glbName = file.name;

      var root = gltf.scene;
      prepareMaterials(root);
      var stats = collectStats(root);

      initPreview();
      if (pv.model) { pv.pivot.remove(pv.model); }
      pv.model = root;
      pv.pivot.add(root);
      pv.on = true;
      $('previewBox').classList.remove('is-hidden');

      state.curFile = file;
      state.curStats = stats;
      previewApply();
      $('startBtn').disabled = false;
      $('startHint').innerHTML = 'マーカーを印刷して机に置いたら、<b>ARをはじめる</b> を押してください。';
    }, undefined, function (err) {
      URL.revokeObjectURL(url);
      var msg = (err && (err.message || err.type)) || String(err);
      $('glbError').textContent =
        'GLBファイルを読み込めませんでした。\n' +
        '・拡張子が .glb / .gltf か確認してください\n' +
        '・ファイルが壊れていないか確認してください\n' +
        '（詳細: ' + msg + '）';
      $('glbError').classList.remove('is-hidden');
      $('startBtn').disabled = true;
    });
  }

  function showInfo(file, stats, fit) {
    var box = $('glbInfo');
    if (!fit) {
      box.innerHTML = '<p class="flag-warn">表示できる面（メッシュ）が見つかりませんでした。</p>';
      box.classList.remove('is-hidden');
      return;
    }
    var s = fit.srcSize;
    var f2 = function (n) { return (Math.round(n * 100) / 100).toLocaleString('ja-JP'); };
    var fcm = function (n) { return (Math.round(n * fit.scale * 100 * 10) / 10).toLocaleString('ja-JP'); };
    var upLabel = { z: 'Z軸が上（CAD由来）', y: 'Y軸が上（glTF標準）' }[fit.detectedUp];
    var rows = [
      ['ファイル', file.name + '（' + Math.round(file.size / 1024).toLocaleString('ja-JP') + ' KB）'],
      ['実際の大きさ', '<b>' + fcm(s.x) + ' × ' + fcm(s.y) + ' × ' + fcm(s.z) + ' cm</b>（ARで表示されるサイズ）'],
      ['もとの寸法', f2(s.x) + ' × ' + f2(s.y) + ' × ' + f2(s.z) + '（GLB内の数値）'],
      ['自動判定した上方向', '<span class="' + (fit.detectedUp === 'z' ? 'flag-ok' : '') + '">' + upLabel + '</span>'],
      ['三角形の数', stats.tri.toLocaleString('ja-JP')],
      ['メッシュ／材質', stats.mesh + ' / ' + stats.mat],
      ['法線なしメッシュ', stats.noNormal === 0
        ? '<span class="flag-ok">なし</span>'
        : '<span class="flag-warn">' + stats.noNormal + '件（自動で再計算しました）</span>']
    ];
    var html = '<dl>';
    rows.forEach(function (r) { html += '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; });
    html += '</dl>';
    html += '<p class="note">「作ってみよう！」の画面に表示されていた大きさと見比べてください。' +
            '実際より小さく表示される場合は、下の「10倍の大きさで表示する」にチェックを入れてください。</p>';
    box.innerHTML = html;
    box.classList.remove('is-hidden');
  }

  /* ============================================================
     4. A-Frame コンポーネント：GLBを読み込んで自動正規化
     ============================================================ */
  AFRAME.registerComponent('auto-glb', {
    schema: {
      src:  { type: 'string' },
      size: { type: 'number', default: 1 },
      lift: { type: 'number', default: 0 },
      up:   { type: 'string', default: 'auto' },
      spin: { type: 'boolean', default: false },
      tenX: { type: 'boolean', default: false }
    },

    init: function () {
      this.pivot = new THREE.Group();       // 回転演出用（正規化とは分離する）
      this.el.object3D.add(this.pivot);
      this.model = null;
      this.loadedSrc = null;
    },

    update: function () {
      if (this.data.src && this.data.src !== this.loadedSrc) { this.load(); }
      else if (this.model) { this.apply(); }
    },

    load: function () {
      var self = this;
      var url = this.data.src;
      new THREE.GLTFLoader().load(url, function (gltf) {
        if (self.model) { self.pivot.remove(self.model); }
        self.model = gltf.scene;
        prepareMaterials(self.model);
        self.pivot.add(self.model);
        self.loadedSrc = url;
        self.apply();
        self.el.emit('glb-ready', {}, false);
      }, undefined, function (err) {
        self.el.emit('glb-error', { message: String((err && err.message) || err) }, true);
      });
    },

    apply: function () {
      if (!this.model) { return; }
      var keep = this.pivot.rotation.y;
      this.pivot.rotation.y = 0;            // 演出回転を除いた状態で正規化する
      fitModel(this.model, { size: this.data.size, lift: this.data.lift, up: this.data.up, tenX: this.data.tenX, arUnitScale: AR_UNIT_SCALE });
      this.pivot.rotation.y = keep;
    },

    tick: function (time, dt) {
      if (this.data.spin && this.model && dt) { this.pivot.rotation.y += dt * 0.0006; }
    },

    remove: function () {
      if (this.model) { this.pivot.remove(this.model); this.model = null; }
    }
  });

  /* ============================================================
     5. AR画面の組み立てと後始末
     ============================================================ */
  function modelData() {
    return { src: state.glbUrl, size: state.size, lift: state.lift, up: state.up, spin: state.spin, tenX: state.scale10x };
  }

  function buildScene() {
    var host = $('sceneHost');
    host.innerHTML = '';

    // AR.js は映像要素を body 直下(z-index:-2)に挿す。#ar は z-index:9000 の
    // 独立した重ね合わせ文脈なので、そのままでは映像が背面に隠れてしまう。
    // シーン生成より先に受け口を用意しておく。
    window.addEventListener('arjs-video-loaded', adoptVideo);

    var arjs = [
      'sourceType: webcam',
      'debugUIEnabled: false',
      'detectionMode: mono',
      'patternRatio: 0.5',
      'maxDetectionRate: 30',
      'cameraParametersUrl: ' + CAM_PARA,
      'sourceWidth: ' + SRC_W,
      'sourceHeight: ' + SRC_H,
      'canvasWidth: ' + DET_W,
      'canvasHeight: ' + DET_H,
      'displayWidth: ' + window.innerWidth,
      'displayHeight: ' + window.innerHeight
    ];
    if (state.deviceId) { arjs.push('deviceId: ' + state.deviceId); }

    var scene = document.createElement('a-scene');
    scene.setAttribute('embedded', '');
    scene.setAttribute('vr-mode-ui', 'enabled: false');
    scene.setAttribute('renderer', 'preserveDrawingBuffer: true; antialias: true; alpha: true');
    scene.setAttribute('light', 'defaultLightsEnabled: false');
    scene.setAttribute('arjs', arjs.join('; '));

    [ 'type: ambient; intensity: 0.85',
      'type: hemisphere; color: #ffffff; groundColor: #9aa3ab; intensity: 0.45',
      'type: directional; intensity: 0.55'
    ].forEach(function (l, i) {
      var e = document.createElement('a-entity');
      e.setAttribute('light', l);
      if (i === 2) { e.setAttribute('position', '1 2 1'); }
      scene.appendChild(e);
    });

    var marker = document.createElement('a-marker');
    marker.setAttribute('id', 'mk');
    // preset は外部URL（ar-js-org.github.io）を取りに行くため使わない。
    // 同梱の .patt を明示指定して、学校ネットワークでも自己完結で動くようにする。
    marker.setAttribute('type', 'pattern');
    marker.setAttribute('url', state.markerMode === 'custom' && state.pattUrl ? state.pattUrl : PATT_HIRO);
    // 【注意】<a-marker size="..."> は同梱のAR.jsビルドでは効果がない(実測で確認済み)。
    // 実寸表示のための換算は AR_UNIT_SCALE を介して fitModel 側で行っている。
    // 手ぶれ・ちらつき対策（現行アプリが不安定に見える一因）
    marker.setAttribute('smooth', 'true');
    marker.setAttribute('smoothCount', '10');
    marker.setAttribute('smoothTolerance', '0.01');
    marker.setAttribute('smoothThreshold', '5');

    var model = document.createElement('a-entity');
    model.setAttribute('id', 'model');
    model.setAttribute('auto-glb', modelData());
    marker.appendChild(model);
    scene.appendChild(marker);

    var cam = document.createElement('a-entity');
    cam.setAttribute('camera', '');
    scene.appendChild(cam);

    host.appendChild(scene);
    state.sceneEl = scene;

    marker.addEventListener('markerFound', function () { $('hint').classList.add('is-off'); });
    marker.addEventListener('markerLost',  function () { $('hint').classList.remove('is-off'); });
    model.addEventListener('glb-error', function (e) {
      showArError('モデルを表示できませんでした。\n（' + (e.detail && e.detail.message) + '）');
    });
  }

  /**
   * AR.js が body 直下に挿した映像要素を AR画面の中へ引き取る。
   * サイズ・位置は AR.js が WebGLキャンバスと一致させているので触らない。
   * 変更するのは「どこにぶら下がるか」と「重ね順」だけ。
   */
  function adoptVideo() {
    var v = document.getElementById('arjs-video');
    var host = $('sceneHost');
    if (!v || !host) { return; }
    host.insertBefore(v, host.firstChild);
    v.style.zIndex = '0';
    v.setAttribute('playsinline', '');
    v.muted = true;
    var cv = host.querySelector('.a-canvas');
    if (cv) { cv.style.zIndex = '1'; }
  }

  function stopAr() {
    window.removeEventListener('arjs-video-loaded', adoptVideo);
    var v = document.getElementById('arjs-video') || document.querySelector('video');
    if (v) {
      if (v.srcObject) {
        v.srcObject.getTracks().forEach(function (t) { t.stop(); });   // カメラを確実に解放
        v.srcObject = null;
      }
      if (v.parentNode) { v.parentNode.removeChild(v); }
    }
    if (state.sceneEl) {
      try { if (state.sceneEl.renderer) { state.sceneEl.renderer.setAnimationLoop(null); } } catch (e) {}
      if (state.sceneEl.parentNode) { state.sceneEl.parentNode.removeChild(state.sceneEl); }
      state.sceneEl = null;
    }
    $('sceneHost').innerHTML = '';
    document.body.classList.remove('ar-mode');
    document.body.style.margin = '';
    document.body.style.overflow = '';
  }

  function showArError(msg) {
    var box = $('arError');
    box.textContent = msg;
    box.classList.remove('is-hidden');
  }

  /* ============================================================
     6. スクリーンショット
        カメラ映像(video)とWebGLキャンバスを2Dキャンバスへ合成する。
        ※ preserveDrawingBuffer: true がないとキャンバスが黒く抜ける
     ============================================================ */
  function capture() {
    var scene = state.sceneEl;
    if (!scene || !scene.renderer) { return null; }
    var gl = scene.renderer.domElement;
    try { scene.renderer.render(scene.object3D, scene.camera); } catch (e) {}

    var W = gl.width, H = gl.height;
    if (!W || !H) { return null; }

    var out = document.createElement('canvas');
    out.width = W; out.height = H;
    var ctx = out.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    // 映像とキャンバスは AR.js により同一矩形に揃えられているが、
    // 端末やタイミングでずれることがあるため実測値で対応付ける。
    var v = document.getElementById('arjs-video') || document.querySelector('video');
    if (v && v.videoWidth) {
      var gr = gl.getBoundingClientRect();
      var vr = v.getBoundingClientRect();
      if (gr.width > 0 && gr.height > 0) {
        var kx = W / gr.width, ky = H / gr.height;
        ctx.drawImage(v,
          (vr.left - gr.left) * kx, (vr.top - gr.top) * ky,
          vr.width * kx, vr.height * ky);
      } else {
        ctx.drawImage(v, 0, 0, W, H);
      }
    }
    ctx.drawImage(gl, 0, 0, W, H);
    return out;
  }

  function shoot() {
    var cv = capture();
    if (!cv) { showArError('写真を撮れませんでした。もう一度お試しください。'); return; }
    $('flash').classList.remove('is-on');
    void $('flash').offsetWidth;                 // アニメーション再生のためリフロー
    $('flash').classList.add('is-on');
    cv.toBlob(function (blob) {
      if (!blob) { showArError('写真を作れませんでした。'); return; }
      state.shotBlob = blob;
      $('shotImg').src = URL.createObjectURL(blob);
      show('shot');
    }, 'image/png');
  }

  function stamp() {
    var d = new Date(), p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
           p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function saveShot() {
    if (!state.shotBlob) { return; }
    var url = URL.createObjectURL(state.shotBlob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'AR_' + stamp() + '.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* ============================================================
     7. 画面遷移
     ============================================================ */
  function show(name) {
    ['home', 'ar', 'shot'].forEach(function (n) {
      $(n).classList.toggle('is-active', n === name);
    });
  }

  function startAr() {
    $('arError').classList.add('is-hidden');
    $('hint').classList.remove('is-off');

    preflightCamera().then(function () {
      document.body.classList.add('ar-mode');
      show('ar');
      buildScene();
    }).catch(function (err) {
      document.body.classList.remove('ar-mode');
      show('ar');
      showArError(cameraErrorMessage(err));
    });
  }

  function preflightCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('NO_API'));
    }
    if (!window.isSecureContext) { return Promise.reject(new Error('INSECURE')); }
    var c = state.deviceId
      ? { video: { deviceId: { exact: state.deviceId } } }
      : { video: { facingMode: 'environment' } };
    return navigator.mediaDevices.getUserMedia(c).then(function (s) {
      s.getTracks().forEach(function (t) { t.stop(); });
    });
  }

  function cameraErrorMessage(err) {
    var n = (err && (err.name || err.message)) || '';
    if (n === 'INSECURE') {
      return 'カメラを使うには https:// または localhost で開く必要があります。\n' +
             '（file:// で直接開くと動きません）';
    }
    if (n === 'NO_API') { return 'このブラウザはカメラに対応していません。Chrome をお使いください。'; }
    if (n === 'NotAllowedError') {
      return 'カメラの使用が許可されませんでした。\n' +
             'アドレスバー左のアイコンからカメラを「許可」にして、もう一度お試しください。';
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError') {
      return 'カメラが見つかりませんでした。\n' +
             'ホーム画面の「4 カメラ」で別のカメラを選んでみてください。';
    }
    if (n === 'NotReadableError') {
      return 'カメラを他のアプリが使用中です。\n他のタブやアプリを閉じてから、もう一度お試しください。';
    }
    return 'カメラを開始できませんでした。（' + n + '）';
  }

  /* ============================================================
     8. UI配線
     ============================================================ */
  function bind() {
    $('glbInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) { loadGlb(f); }
    });

    Array.prototype.forEach.call(document.getElementsByName('mk'), function (r) {
      r.addEventListener('change', function () {
        state.markerMode = r.value;
        $('pattInput').classList.toggle('is-hidden', r.value !== 'custom');
      });
    });

    $('pattInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) { return; }
      if (state.pattUrl) { URL.revokeObjectURL(state.pattUrl); }
      state.pattUrl = URL.createObjectURL(f);
      state.pattName = f.name;
      $('pattName').textContent = '選択中: ' + f.name;
      $('pattName').classList.remove('is-hidden');
    });

    $('sizeRange').addEventListener('input', function (e) {
      state.size = parseFloat(e.target.value);
      $('sizeVal').textContent = state.size.toFixed(1);
      previewApply();
      updateModelLive();
    });

    $('tenXChk').addEventListener('change', function (e) {
      state.scale10x = e.target.checked;
      previewApply();
      updateModelLive();
    });

    $('liftRange').addEventListener('input', function (e) {
      state.lift = parseFloat(e.target.value);
      $('liftVal').textContent = state.lift.toFixed(2);
      previewApply();
      updateModelLive();
    });

    $('upSelect').addEventListener('change', function (e) {
      state.up = e.target.value;
      previewApply();
      updateModelLive();
    });

    $('spinChk').addEventListener('change', function (e) {
      state.spin = e.target.checked;
      updateModelLive();
    });

    $('camListBtn').addEventListener('click', listCameras);
    $('camSelect').addEventListener('change', function (e) { state.deviceId = e.target.value; });

    $('startBtn').addEventListener('click', startAr);
    $('backBtn').addEventListener('click', function () { stopAr(); show('home'); });

    $('shutter').addEventListener('click', shoot);
    $('smallBtn').addEventListener('click', function () { nudgeSize(-0.15); });
    $('bigBtn').addEventListener('click',   function () { nudgeSize(+0.15); });
    $('upBtn').addEventListener('click', cycleUp);

    $('retakeBtn').addEventListener('click', function () { show('ar'); });
    $('saveBtn').addEventListener('click', saveShot);

    window.addEventListener('beforeunload', stopAr);
  }

  function updateModelLive() {
    var m = document.getElementById('model');
    if (m) { m.setAttribute('auto-glb', modelData()); }
  }

  function nudgeSize(d) {
    state.size = Math.min(3, Math.max(0.3, Math.round((state.size + d) * 100) / 100));
    $('sizeRange').value = state.size;
    $('sizeVal').textContent = state.size.toFixed(1);
    previewApply();
    updateModelLive();
  }

  function cycleUp() {
    var order = ['auto', 'z', 'y'];
    state.up = order[(order.indexOf(state.up) + 1) % order.length];
    $('upSelect').value = state.up;
    previewApply();
    updateModelLive();
    var label = { auto: '自動', z: 'Z軸が上', y: 'Y軸が上' }[state.up];
    var hint = $('hint');
    hint.textContent = '向き: ' + label;
    hint.classList.remove('is-off');
    clearTimeout(cycleUp._t);
    cycleUp._t = setTimeout(function () {
      hint.textContent = 'マーカーをカメラにうつしてください';
      if (document.querySelector('#mk') && document.querySelector('#mk').object3D.visible) {
        hint.classList.add('is-off');
      }
    }, 1500);
  }

  function listCameras() {
    var sel = $('camSelect');
    navigator.mediaDevices.getUserMedia({ video: true }).then(function (s) {
      s.getTracks().forEach(function (t) { t.stop(); });
    }).catch(function () { /* 拒否されてもラベルなしで列挙を試みる */ })
      .then(function () { return navigator.mediaDevices.enumerateDevices(); })
      .then(function (devs) {
        var cams = devs.filter(function (d) { return d.kind === 'videoinput'; });
        sel.innerHTML = '<option value="">自動（おまかせ）</option>';
        cams.forEach(function (c, i) {
          var o = document.createElement('option');
          o.value = c.deviceId;
          o.textContent = c.label || ('カメラ ' + (i + 1));
          sel.appendChild(o);
        });
        $('camListBtn').textContent = cams.length + '台みつかりました（再取得）';
      })
      .catch(function () { $('camListBtn').textContent = 'カメラ一覧を取得できませんでした'; });
  }

  /* ---------- 起動 ---------- */
  bind();
})();
