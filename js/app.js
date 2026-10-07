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
  // 画面の一番下に出す版。app/ を変更して公開するたびに上げる。
  // 公開後に「配信されている js/app.js にこの文字列があるか」で反映を確かめられる。
  var APP_VERSION = '2026-10-07';

  var PATT_HIRO  = 'marker/pattern-hiro.patt';      // Hiroマーカー（同梱）
  // カメラに希望する解像度。実際に届く大きさは端末しだい（16:9を出せないカメラもある）なので、
  // 検出と表示の設定は、届いた映像の縦横比を見てから決める（detGeometry / layoutStage）。
  var SRC_W      = 1280;
  var SRC_H      = 720;
  // マーカー検出に使う内部キャンバスの長辺(px)。
  var DET_LONG   = 640;
  // カメラの焦点距離の想定（映像の長辺を640pxに換算した値）。水平画角55.4°に当たる。
  // AR.js標準の校正データと同じ値。2026-10-07に、実機で撮った写真のA4用紙の四隅から
  // 逆算した値は約54°（読み取り誤差込みで52〜57°）で、ほぼ一致していた。
  var CAM_F      = 609.4;

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
    size: 1.0, lift: 0, up: 'auto', spin: false, rawScale: false,
    deviceId: '',
    sceneEl: null,
    det: null,            // いまのAR.jsに渡してある検出の設定（detGeometry の戻り値）
    frame: null,          // カメラ映像の実際の大きさ {w,h}
    streamDims: null,     // 作り直しのとき、次に届く映像の大きさとして使う値
    restarts: 0,          // 映像の縦横比の食い違いで自動的にやり直した回数
    stageRect: '',        // 最後に適用した台の位置と大きさ（同じなら何もしないため）
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
    //    「作ってみよう！」は画面表示の1/10の数値で書き出すことが多いため、
    //    既定で×10を適用する。まれにそのまま正しいmm値で書き出されている場合は
    //    opts.rawScale を立てて×10を外す（生徒が触るのは救済用チェックのみ）。
    //    手動の微調整(opts.size)も併せて掛け合わせる。
    //    opts.arUnitScale は AR画面だけに必要な追加変換（下記参照）。
    //    プレビューでは渡さない＝1のまま＝素直に実メートル。
    var realScale = MM_TO_M * (opts.rawScale ? 1 : 10) * (opts.size || 1);
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
    var fit = fitModel(pv.model, { size: state.size, lift: state.lift, up: state.up, rawScale: state.rawScale });
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
            '実際より大きく表示される場合は、下の「大きすぎる場合はチェック」にチェックを入れてください。</p>';
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
      rawScale: { type: 'boolean', default: false }
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
      fitModel(this.model, { size: this.data.size, lift: this.data.lift, up: this.data.up, rawScale: this.data.rawScale, arUnitScale: AR_UNIT_SCALE });
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

     画面の構造:
       #sceneHost   画面いっぱいの「窓」。はみ出した分は切り落とす
         #stage       映像と3Dを載せる「台」。台ごと拡大して窓を覆う
           #videoBox    カメラ映像の置き場
           a-scene      3D（台と同じ大きさ）

     なぜ台が要るか:
       AR.js は映像を「縦横比を保ったまま画面を覆う」ように拡大するが、A-Frame利用時は
       3Dキャンバスを映像に合わせない（画面の大きさのまま）。画面と映像の縦横比が違うと
       ——実機ではアドレスバー等があるので必ず違う——3Dだけが押しつぶされて見える。
       3Dの投影は「映像の全体」に対して決まっているので、3Dキャンバスは映像と
       ぴったり同じ矩形に重なっていなければならない。
     ============================================================ */
  function modelData() {
    return { src: state.glbUrl, size: state.size, lift: state.lift, up: state.up, spin: state.spin, rawScale: state.rawScale };
  }

  /**
   * 届いた映像の大きさから、マーカー検出の設定を決める。
   *   w, h  検出キャンバスの大きさ（AR.js の作法で常に横長）
   *   f     検出キャンバス上での焦点距離(px)
   *   frac  検出キャンバスの幅のうち、映像が占める割合
   * AR.js は検出キャンバスへ、横長の映像は「全面に引き伸ばして」、縦長の映像は
   * 「中央に、高さいっぱい・幅 h*h/w の帯として」描く。どちらでも映像の画素が正方形の
   * まま写るよう、キャンバスの縦横比を映像に合わせる。ここが食い違うと、マーカーの面は
   * 合って見えるのに立体の高さだけが狂う（2026-10-06に判明。CLAUDE.md 5番）。
   */
  function detGeometry(vw, vh) {
    var even = function (n) { return Math.round(n / 2) * 2; };
    if (vw >= vh) {
      return { w: DET_LONG, h: even(DET_LONG * vh / vw), f: CAM_F, frac: 1 };
    }
    var h = 480, w = even(h * vh / vw);
    return { w: w, h: h, f: CAM_F * h / DET_LONG, frac: (h / w) * (h / w) };
  }

  /**
   * ARToolKit のカメラ校正データ（ARParam 第4版: 176バイト・ビッグエンディアン）を
   * 検出の設定に合わせて作り、blob: のURLで渡す。外部へは何も取りに行かない。
   * 光学中心は画像の中央、レンズのゆがみは無し、縦横の焦点距離は同じ（正方画素）とする。
   * AR.js標準の camera_para.dat（640x480用）は使わない。別の縦横比のキャンバスに使うと
   * AR.js が縦横を別々に換算し、縦の焦点距離だけが変わってしまう。
   */
  var camParamUrls = {};
  function cameraParamUrl(g) {
    var key = [g.w, g.h, g.f].join('_');
    if (!camParamUrls[key]) {
      var dv = new DataView(new ArrayBuffer(176));
      dv.setInt32(0, g.w);
      dv.setInt32(4, g.h);
      [ g.f, 0, g.w / 2, 0,
        0, g.f, g.h / 2, 0,
        0, 0, 1, 0,                              // ここまで 3x4 の射影行列
        0, 0, 0, 0,                              // ゆがみ係数 k1 k2 p1 p2
        g.f, g.f, g.w / 2, g.h / 2, 1            // fx fy cx cy 倍率
      ].forEach(function (v, i) { dv.setFloat64(8 + i * 8, v); });
      camParamUrls[key] = URL.createObjectURL(new Blob([dv.buffer]));
    }
    return camParamUrls[key];
  }

  function buildScene() {
    // 検出の設定は、映像が届いた時点（onVideoLoaded）で実際の大きさに合わせ直す。
    // ここには「希望どおりの大きさが届いた場合」の値を入れておく。
    state.det = detGeometry(SRC_W, SRC_H);
    var arjs = [
      'sourceType: webcam',
      'debugUIEnabled: false',
      'detectionMode: mono',
      'patternRatio: 0.5',
      'maxDetectionRate: 30',
      'cameraParametersUrl: ' + cameraParamUrl(state.det),
      'sourceWidth: ' + SRC_W,
      'sourceHeight: ' + SRC_H,
      'canvasWidth: ' + state.det.w,
      'canvasHeight: ' + state.det.h
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

    $('stage').appendChild(scene);
    state.sceneEl = scene;

    marker.addEventListener('markerFound', function () { $('hint').classList.add('is-off'); });
    marker.addEventListener('markerLost',  function () { $('hint').classList.remove('is-off'); });
    model.addEventListener('glb-error', function (e) {
      showArError('モデルを表示できませんでした。\n（' + (e.detail && e.detail.message) + '）');
    });
  }

  /** いま動いている AR.js のセッション（まだ無ければ null） */
  function arSession() {
    var sys = state.sceneEl && state.sceneEl.systems && state.sceneEl.systems.arjs;
    return (sys && sys._arSession) || null;
  }

  function releaseVideo(v) {
    if (v.srcObject) {
      v.srcObject.getTracks().forEach(function (t) { t.stop(); });   // カメラを確実に解放
      v.srcObject = null;
    }
    v.remove();
  }

  /**
   * AR.js がカメラ映像を用意できた直後に呼ばれる（AR.js は映像要素を body 直下に挿す）。
   *   (1) 映像要素を、台の中へ引き取る
   *   (2) 届いた映像の縦横比に、検出の設定と台の形を合わせる
   * AR.js 自身もこの同じ合図で検出器の初期化を始めるが、こちらは起動時に登録してあるので
   * 必ず先に呼ばれ、初期化には書き換えた後の設定が使われる。
   */
  function onVideoLoaded() {
    var sess = arSession();
    var v = sess && sess.arSource.domElement;
    // いまのAR以外の映像は、カメラごと止める。
    // （はじめてすぐ「もどる」を押すと、片づけた後になってから映像が届くことがある）
    Array.prototype.forEach.call(document.querySelectorAll('#arjs-video'), function (other) {
      if (other !== v) { releaseVideo(other); }
    });
    if (!v || !v.srcObject || v.parentNode === $('videoBox')) { return; }
    $('videoBox').appendChild(v);
    v.setAttribute('playsinline', '');
    v.muted = true;
    v.addEventListener('loadedmetadata', onVideoSize);
    v.addEventListener('resize', onVideoSize);

    var st = v.srcObject.getVideoTracks()[0].getSettings();
    state.frame = state.streamDims || { w: st.width, h: st.height };
    state.streamDims = null;
    state.det = detGeometry(state.frame.w, state.frame.h);
    var p = sess.arContext.parameters;
    p.canvasWidth = state.det.w;
    p.canvasHeight = state.det.h;
    p.cameraParametersUrl = cameraParamUrl(state.det);
    // AR.js は検出器の初期化が済んだ時点の「映像要素の縦横」で横長／縦長を決める。
    // その前に台を正しい形にしておく。
    layoutStage();
  }

  /** 映像の実際の大きさが分かったとき／途中で変わったとき（端末を回したときなど） */
  function onVideoSize(e) {
    var v = e.target;
    if (!v.videoWidth || !state.sceneEl) { return; }
    var g = detGeometry(v.videoWidth, v.videoHeight);
    var dims = { w: v.videoWidth, h: v.videoHeight };     // 片づけると0になるので先に控える
    if ((g.w !== state.det.w || g.h !== state.det.h) && state.restarts < 3) {
      // 検出の設定と映像の縦横比が食い違った。検出器は作り直さないと設定を変えられないので、
      // いま分かった大きさを前提に AR をはじめからやり直す。
      // （回数に上限を置くのは、万一食い違いが解消しない端末でカメラの再起動を繰り返さないため）
      state.restarts++;
      teardownScene();
      state.streamDims = dims;
      buildScene();
      return;
    }
    state.frame = dims;
    layoutStage();
  }

  /**
   * 台(#stage)を、映像が窓(#sceneHost)を覆う大きさ・位置に合わせる。
   * 3Dキャンバスは台と同じ大きさになるので、映像と3Dが必ず同じ矩形に重なる。
   * 端数のある位置に置くと映像がにじむので、すべて整数の画素にそろえる。
   */
  function layoutStage() {
    var fr = state.frame;
    if (!fr || !state.sceneEl) { return; }
    var host = $('sceneHost'), W = host.clientWidth, H = host.clientHeight;
    var k = Math.max(W / fr.w, H / fr.h);                 // 縦横比を保ったまま窓を覆う倍率
    var vw = Math.round(fr.w * k), vh = Math.round(fr.h * k);
    var sw = Math.round(vw / state.det.frac);             // 横長の映像なら 台＝映像
    var rect = [Math.round((W - sw) / 2), Math.round((H - vh) / 2), sw, vh, vw];
    if (rect.join() === state.stageRect) { return; }
    state.stageRect = rect.join();
    place($('stage'), rect[0], rect[1], sw, vh);
    place($('videoBox'), Math.round((sw - vw) / 2), 0, vw, vh);
    state.sceneEl.resize();                               // A-Frame に、3Dキャンバスを台の大きさへ合わせ直させる
  }

  function place(el, left, top, w, h) {
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
  }

  /** シーン・映像・AR.js のセッションを片づける（AR画面そのものは閉じない） */
  function teardownScene() {
    Array.prototype.forEach.call(document.querySelectorAll('#arjs-video'), releaseVideo);
    var scene = state.sceneEl;
    if (scene) {
      try { if (scene.renderer) { scene.renderer.setAnimationLoop(null); } } catch (e) {}
      var sess = arSession();
      if (sess) {
        // AR.js は window に登録したリスナーを外す手段を持たない。残しておくと、次に始めたとき
        // 古いセッションが検出器をもう1つ作り、画面の大きさが変わるたびに古い映像の寸法を
        // body に書き戻す。中身を空にして止め、検出器（WASM）も解放する。
        sess.arContext.init = function () {};
        sess.arSource.onResize = function () {};
        sess.arSource.copyElementSizeTo = function () {};
        // 解放は少し待ってから。初期化の途中で解放すると、AR.js の残りの初期化処理が
        // 空になった検出器に触れてエラーになる。
        setTimeout(function () { sess.arContext.dispose(); }, 5000);
      }
      scene.remove();
      state.sceneEl = null;
    }
    $('stage').removeAttribute('style');
    $('videoBox').removeAttribute('style');
    state.frame = null;
    state.stageRect = '';
  }

  function stopAr() {
    teardownScene();
    state.streamDims = null;
    state.restarts = 0;
    document.body.classList.remove('ar-mode');
    // AR.js が body に書き込んだ寸法と余白を消す
    ['width', 'height', 'margin', 'overflow'].forEach(function (p) { document.body.style[p] = ''; });
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
    var v = document.getElementById('arjs-video');
    if (!scene || !scene.renderer || !v || !v.videoWidth) { return null; }
    var gl = scene.renderer.domElement;
    try { scene.renderer.render(scene.object3D, scene.camera); } catch (e) {}

    // 写真にするのは「窓」に見えている範囲。台は窓より大きいので、はみ出した分は写さない。
    var hr = $('sceneHost').getBoundingClientRect();
    var gr = gl.getBoundingClientRect();
    var vr = v.getBoundingClientRect();
    if (!gr.width) { return null; }
    var k = window.devicePixelRatio || 1;        // 画面と同じ細かさで撮る

    var out = document.createElement('canvas');
    out.width = Math.round(hr.width * k);
    out.height = Math.round(hr.height * k);
    var ctx = out.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(v, (vr.left - hr.left) * k, (vr.top - hr.top) * k, vr.width * k, vr.height * k);
    ctx.drawImage(gl, (gr.left - hr.left) * k, (gr.top - hr.top) * k, gr.width * k, gr.height * k);
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

    $('rawScaleChk').addEventListener('change', function (e) {
      state.rawScale = e.target.checked;
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
    // AR用の受け口は常設する（AR.js より先に呼ばれる必要がある。onVideoLoaded 参照）
    window.addEventListener('arjs-video-loaded', onVideoLoaded);
    window.addEventListener('resize', layoutStage);
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
  $('appVer').textContent = 'バージョン ' + APP_VERSION;
})();
