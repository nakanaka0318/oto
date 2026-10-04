'use strict';
/*
 * 音ズレ自動補正
 *  メトロノームのクリック音に合わせてタップ → 実際に音が聞こえた時刻とタップ時刻の差を計測
 *  外れ値を除いた平均をオフセットとして自動適用する
 *  (イヤホン・Bluetooth・端末ごとの出力遅延 + タッチ入力の遅延 + 本人のクセ をまとめて吸収)
 */
const Calibrator = {
  BPM: 100, COUNT_IN: 4, NEED: 16, TOTAL: 30,

  init(app) {
    this.app = app;
    const pad = $('#calib-pad');
    pad.addEventListener('pointerdown', e => { e.preventDefault(); if (this.running) this.tap(e.timeStamp); else if (!this.result) this.start(); });
    window.addEventListener('keydown', e => {
      if ($('#modal-calib').hidden || e.repeat) return;
      if (e.code === 'Escape') { this.close(); return; }
      if (this.running) { e.preventDefault(); this.tap(e.timeStamp); }
    });
    $('#calib-start').onclick = () => this.start();
    $('#calib-undo').onclick = () => {
      if (this.prev == null) return;
      Settings.data.offset = this.prev; Settings.save();
      this.app.toast('オフセットを元に戻しました (' + this.fmt(this.prev) + ')');
      $('#calib-undo').hidden = true;
      this.app.refreshSettingsUI();
    };
    $('#calib-close').onclick = () => this.close();
    $('#calib-auto').onchange = e => { Settings.data.autoOffset = e.target.checked; Settings.save(); };
  },
  fmt(ms) { return (ms > 0 ? '+' : '') + ms + 'ms'; },

  open() {
    this.stop();
    this.result = null; this.prev = null;
    $('#calib-msg').textContent = 'タップしてスタート';
    $('#calib-sub').textContent = '';
    $('#calib-result').innerHTML = `現在のオフセット: <b>${this.fmt(Settings.data.offset || 0)}</b>`;
    $('#calib-undo').hidden = true;
    $('#calib-start').textContent = 'スタート';
    $('#calib-auto').checked = !!Settings.data.autoOffset;
    this.renderDots();
    $('#modal-calib').hidden = false;
  },
  close() {
    this.stop();
    $('#modal-calib').hidden = true;
    this.app.refreshSettingsUI();
  },

  start() {
    const eng = this.app.engine, ctx = eng.ensure();
    this.stop();
    this.result = null;
    this.beat = 60 / this.BPM;
    this.t0 = ctx.currentTime + 0.8;
    this.taps = [];
    this.nodes = [];
    const g = ctx.createGain(); g.gain.value = Math.max(0.5, Settings.data.seVol); g.connect(eng.master);
    for (let k = 0; k < this.TOTAL; k++) {
      const src = ctx.createBufferSource();
      src.buffer = k % 4 === 0 ? eng.se.clickHi : eng.se.click;
      src.connect(g);
      src.start(this.t0 + k * this.beat);
      this.nodes.push(src);
    }
    this.gain = g;
    this.running = true;
    $('#calib-start').textContent = 'やり直す';
    $('#calib-undo').hidden = true;
    $('#calib-result').textContent = '';
    this.renderDots();
    const loop = () => {
      if (!this.running) return;
      const heard = eng.ctxTimeAtPerf(performance.now());
      const k = Math.floor((heard - this.t0) / this.beat);
      if (k < 0) { $('#calib-msg').textContent = '準備…'; $('#calib-sub').textContent = 'クリック音を聞いてください'; }
      else if (k < this.COUNT_IN) { $('#calib-msg').textContent = String(this.COUNT_IN - k); $('#calib-sub').textContent = '次の「4」から音に合わせてタップ'; }
      else { $('#calib-msg').textContent = 'TAP!'; $('#calib-sub').textContent = '画面ではなく「音」に合わせてください'; }
      if (heard > this.t0 + this.TOTAL * this.beat + 0.3) { this.finish(); return; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  },
  stop() {
    this.running = false;
    (this.nodes || []).forEach(n => { try { n.stop(); } catch (e) { /* ignore */ } });
    this.nodes = [];
    if (this.gain) { this.gain.disconnect(); this.gain = null; }
  },
  tap(perfTs) {
    const c = this.app.engine.ctxTimeAtPerf(perfTs);
    const pad = $('#calib-pad');
    pad.classList.remove('hit'); void pad.offsetWidth; pad.classList.add('hit');
    const k = Math.round((c - this.t0) / this.beat);
    if (k < this.COUNT_IN || k >= this.TOTAL) return;
    const d = c - (this.t0 + k * this.beat);
    if (Math.abs(d) > this.beat * 0.4) return;
    this.taps.push(d);
    this.renderDots();
    if (this.taps.length >= this.NEED) this.finish();
  },
  renderDots() {
    const n = this.taps ? this.taps.length : 0;
    $('#calib-dots').innerHTML = Array.from({ length: this.NEED }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
  },
  finish() {
    this.stop();
    const r = U.robustCenter(this.taps || []);
    if (r.n < 8) {
      $('#calib-msg').textContent = 'もう一度';
      $('#calib-sub').textContent = '';
      $('#calib-result').textContent = 'タップが足りませんでした。クリック音に合わせて 16 回タップしてください。';
      return;
    }
    const ms = U.clamp(Math.round(r.center * 1000), -400, 400);
    const sd = Math.round(r.spread * 1000);
    this.prev = Settings.data.offset || 0;
    this.result = ms;
    Settings.data.offset = ms;
    Settings.data.calibrated = true;
    Settings.save();
    const quality = sd <= 20 ? '◎ とても安定' : sd <= 35 ? '○ 良好' : '△ ばらつき大 (もう一度やると精度が上がります)';
    $('#calib-msg').textContent = this.fmt(ms);
    $('#calib-sub').textContent = '補正を適用しました';
    $('#calib-result').innerHTML = `計測結果 <b>${this.fmt(ms)}</b> (ばらつき ±${sd}ms ${quality})<br>` +
      `<span class="tiny">${ms > 30 ? '音が遅れて届く環境です (Bluetooth イヤホン等)。ノーツの判定を遅らせて合わせました。' : ms < -30 ? 'タップが早めになる傾向です。判定を早めて合わせました。' : 'ほぼズレのない環境です。'} 前回: ${this.fmt(this.prev)}</span>`;
    $('#calib-undo').hidden = this.prev === ms;
  },
};
