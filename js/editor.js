'use strict';
/*
 * 譜面エディタ
 *  縦スクロールのタイムライン (下→上に時間が進む / プレイ画面と同じ向き)
 *  タップ・フリック・ロング(スライド)・クリティカル・消去、スナップ、BPM/オフセット、
 *  リアルタイム録音、自動生成、Undo、JSON入出力、テストプレイ
 */
class Editor {
  constructor(app) {
    this.app = app;
    this.cv = $('#ed-canvas'); this.g = this.cv.getContext('2d');
    this.tool = 'tap'; this.crit = false; this.width = 3; this.dir = 'up'; this.endFlick = false;
    this.snapDiv = 16; this.pps = 320; this.active = false;
    this.hover = null; this.drag = null; this.rec = false; this.recDown = {};
    this.undoStack = []; this.taps = [];
    this._bindDom();
  }

  get chart() { return this.charts[this.diff]; }
  get beat() { return 60 / this.bpm; }
  get snapStep() { return this.beat * 4 / this.snapDiv; }
  get duration() { return this.source.duration || this.song.duration || 180; }

  /* ---------- 開く / 閉じる ---------- */
  open({ song, source, diff, peaks }) {
    this.song = song; this.source = source; this.peaks = peaks || null;
    this.charts = {};
    for (const d of DIFFS) {
      const c = song.charts && song.charts[d];
      this.charts[d] = { notes: c ? JSON.parse(JSON.stringify(c.notes || [])) : [], level: c ? c.level ?? null : null };
    }
    this.bpm = song.bpm || 120; this.offset = song.offset || 0;
    this.diff = diff || 'expert';
    this.viewT = 0; this.undoStack = []; this.dirty = false; this.rec = false;
    $('#ed-title').textContent = song.title;
    $('#ed-bpm').value = this.bpm; $('#ed-offset').value = +this.offset.toFixed(3);
    this.activate();
  }
  activate() {
    this.active = true;
    this.source.rate = 1;
    $('#ed-rate').value = '1';
    this._syncUI();
    const yt = this.source.kind === 'youtube';
    $('#yt-slot-editor').hidden = !yt;
    if (yt) this.app.placeYT('slot', $('#yt-slot-editor'));
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('resize', this._onResize);
    requestAnimationFrame(() => { this.resize(); this._loop(); });
  }
  deactivate() {
    this.active = false;
    try { this.source.pause(); } catch (e) { /* ignore */ }
    if (this.source.rate !== 1) this.source.setRate(1);
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('resize', this._onResize);
    cancelAnimationFrame(this.raf);
  }

  _syncUI() {
    $$('#ed-diffs button').forEach(b => b.classList.toggle('active', b.dataset.diff === this.diff));
    $$('#ed-tools button').forEach(b => b.classList.toggle('active', b.dataset.tool === this.tool));
    $('#ed-crit').checked = this.crit;
    $('#ed-width').value = this.width; $('#ed-width-v').textContent = this.width;
    $('#ed-dir').value = this.dir; $('#ed-endflick').checked = this.endFlick;
    $('#ed-snap').value = String(this.snapDiv); $('#ed-zoom').value = this.pps;
    $('#ed-level').value = this.chart.level ?? '';
    $('#ed-level').placeholder = String(ChartGen.calcLevel({ notes: this.chart.notes }));
    const r = $('#ed-rec'); r.classList.toggle('on', this.rec); r.textContent = this.rec ? '● 録音 ON' : '● 録音 OFF';
    this._stats();
  }
  _stats() {
    const ns = this.chart.notes;
    const c = { tap: 0, flick: 0, hold: 0 };
    ns.forEach(n => c[n.type]++);
    $('#ed-stats').textContent = `ノーツ ${ns.length} (タップ${c.tap} / フリック${c.flick} / ロング${c.hold})  推定Lv ${ChartGen.calcLevel({ notes: ns })}`;
    $('#ed-level').placeholder = String(ChartGen.calcLevel({ notes: ns }));
  }

  /* ---------- DOM ---------- */
  _bindDom() {
    $$('#ed-diffs button').forEach(b => b.onclick = () => { this.diff = b.dataset.diff; this.undoStack = []; this._syncUI(); });
    $$('#ed-tools button').forEach(b => b.onclick = () => { this.tool = b.dataset.tool; this._syncUI(); });
    $('#ed-crit').onchange = e => { this.crit = e.target.checked; };
    $('#ed-width').oninput = e => { this.width = +e.target.value; $('#ed-width-v').textContent = this.width; };
    $('#ed-dir').onchange = e => { this.dir = e.target.value; };
    $('#ed-endflick').onchange = e => { this.endFlick = e.target.checked; };
    $('#ed-snap').onchange = e => { this.snapDiv = +e.target.value; };
    $('#ed-zoom').oninput = e => { this.pps = +e.target.value; };
    $('#ed-level').onchange = e => { const v = parseInt(e.target.value, 10); this.chart.level = v > 0 ? v : null; this.dirty = true; };
    $('#ed-bpm').onchange = e => { const v = parseFloat(e.target.value); if (v >= 30 && v <= 400) { this.bpm = v; this.dirty = true; } else e.target.value = this.bpm; };
    $('#ed-offset').onchange = e => { const v = parseFloat(e.target.value); if (isFinite(v)) { this.offset = v; this.dirty = true; } };
    $('#ed-setoff').onclick = () => {
      const b = this.beat;
      this.offset = +(((this.viewT % b) + b) % b).toFixed(3);
      $('#ed-offset').value = this.offset; this.dirty = true;
      this.app.toast('1拍目を ' + this.offset.toFixed(3) + ' 秒に設定しました');
    };
    $('#ed-tapbpm').onclick = () => {
      const now = performance.now();
      if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
      this.taps.push(now);
      if (this.taps.length > 12) this.taps.shift();
      if (this.taps.length >= 4) {
        const iv = (this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1);
        const bpm = Math.round(60000 / iv * 10) / 10;
        $('#ed-tapinfo').textContent = bpm + ' BPM (クリックで適用)';
        $('#ed-tapinfo').onclick = () => { this.bpm = bpm; $('#ed-bpm').value = bpm; this.dirty = true; };
      } else $('#ed-tapinfo').textContent = `あと${4 - this.taps.length}回`;
    };
    $('#ed-rec').onclick = () => { this.rec = !this.rec; this._syncUI(); if (this.rec) this.app.toast('録音ON: 再生してキー S D F J K L を叩いてください'); };
    $('#ed-auto').onclick = () => this.autoGen();
    $('#ed-copyfrom').onchange = e => {
      const from = e.target.value; e.target.value = '';
      if (!from || from === this.diff) return;
      if (!confirm(`${DIFF_LABEL[from]} の譜面を ${DIFF_LABEL[this.diff]} にコピーします (現在の譜面は上書き)`)) return;
      this.pushUndo();
      this.chart.notes = JSON.parse(JSON.stringify(this.charts[from].notes));
      this._stats();
    };
    $('#ed-clear').onclick = () => {
      if (!confirm('この難易度のノーツを全て消去しますか？')) return;
      this.pushUndo(); this.chart.notes = []; this._stats();
    };
    $('#ed-export').onclick = () => {
      const data = { format: 'oto-chart', version: 1, title: this.song.title, artist: this.song.artist, bpm: this.bpm, offset: this.offset, charts: this.charts };
      U.download((this.song.title || 'chart').replace(/[\\/:*?"<>|]/g, '_') + '.oto.json', JSON.stringify(data));
    };
    $('#ed-import').onchange = async e => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      try {
        const obj = JSON.parse(await f.text());
        this.pushUndo();
        if (obj.charts) {
          for (const d of DIFFS) if (obj.charts[d]) this.charts[d] = { notes: obj.charts[d].notes || [], level: obj.charts[d].level ?? null };
        } else if (Array.isArray(obj.notes)) this.chart.notes = obj.notes;
        else throw new Error('形式が違います');
        if (obj.bpm) { this.bpm = obj.bpm; $('#ed-bpm').value = obj.bpm; }
        if (obj.offset != null) { this.offset = obj.offset; $('#ed-offset').value = obj.offset; }
        this._syncUI(); this.app.toast('譜面を読み込みました');
      } catch (err) { this.app.toast('読み込み失敗: ' + err.message); }
    };
    $('#ed-undo').onclick = () => this.undo();
    $('#ed-save').onclick = () => this.save();
    $('#ed-test').onclick = () => this.testPlay();
    $('#ed-back').onclick = () => {
      if (this.dirty && !confirm('保存していない変更があります。破棄して戻りますか？')) return;
      this.deactivate();
      this.app.backFromEditor();
    };
    $('#ed-play').onclick = () => this.togglePlay();
    $('#ed-seek').oninput = e => this.seek(e.target.value / 1000 * this.duration);
    $('#ed-rate').onchange = e => this.source.setRate(+e.target.value);

    const cv = this.cv;
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointerdown', e => this._down(e));
    cv.addEventListener('pointermove', e => this._move(e));
    cv.addEventListener('pointerup', e => this._up(e));
    cv.addEventListener('pointercancel', () => { this.drag = null; });
    cv.addEventListener('pointerleave', () => { this.hover = null; });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      if (e.ctrlKey) { this.pps = U.clamp(this.pps * (e.deltaY < 0 ? 1.1 : 0.9), 80, 1200); $('#ed-zoom').value = this.pps; return; }
      const dt = -e.deltaY / this.pps * 0.8;
      this.seek(this.viewT + dt);
    }, { passive: false });

    this._onResize = () => this.resize();
    this._onKey = e => this._key(e);
    this._onKeyUp = e => this._keyUp(e);
    this._loop = () => {
      if (!this.active) return;
      this.raf = requestAnimationFrame(this._loop);
      this._frame();
    };
  }

  /* ---------- 再生 ---------- */
  togglePlay() {
    this.app.engine.ensure();
    if (this.source.playing) { this.source.pause(); this.viewT = this.source.pos; }
    else { this.source.play(Math.max(0, this.viewT)); this.lastTick = this.viewT; }
    $('#ed-play').textContent = this.source.playing ? '⏸' : '▶';
  }
  seek(t) {
    t = U.clamp(t, -2, this.duration);
    this.viewT = t;
    if (this.source.playing) { this.source.seek(Math.max(0, t)); this.lastTick = t; }
    else this.source.pos = Math.max(0, t);
  }

  /* ---------- 編集 ---------- */
  pushUndo() {
    this.undoStack.push({ diff: this.diff, notes: JSON.stringify(this.chart.notes) });
    if (this.undoStack.length > 150) this.undoStack.shift();
    this.dirty = true;
  }
  undo() {
    const s = this.undoStack.pop();
    if (!s) { this.app.toast('これ以上戻せません'); return; }
    this.charts[s.diff].notes = JSON.parse(s.notes);
    this.diff = s.diff;
    this._syncUI();
  }
  snapT(t) { const st = this.snapStep; return this.offset + Math.round((t - this.offset) / st) * st; }
  laneFromX(x, w) {
    const lp = (x - this.x0) / this.lw;
    return U.clamp(Math.round(lp - w / 2), 0, 12 - w);
  }
  addNote(n, undo = true) {
    if (undo) this.pushUndo();
    const ns = this.chart.notes;
    for (let i = ns.length - 1; i >= 0; i--) {
      const o = ns[i];
      if (Math.abs(o.t - n.t) < 1e-4 && o.lane < n.lane + n.w && o.lane + o.w > n.lane) ns.splice(i, 1);
    }
    ns.push(n);
    ns.sort((a, b) => a.t - b.t || a.lane - b.lane);
    this._stats();
  }
  newNote(type, t, lane, w) {
    const n = { t: +t.toFixed(4), lane, w, type, crit: this.crit };
    if (type === 'flick') n.dir = this.dir;
    return n;
  }
  hitTest(x, y) {
    const ns = this.chart.notes;
    let best = null, bd = 1e9;
    for (const n of ns) {
      const yh = this.yAt(n.t);
      if (n.type === 'hold') {
        const ye = this.yAt(n.end);
        if (y > yh + 8 || y < ye - 8) continue;
        const t = U.clamp(this.timeAtY(y), n.t, n.end);
        const k = n.end > n.t ? (t - n.t) / (n.end - n.t) : 0;
        const l = U.lerp(n.lane, n.endLane ?? n.lane, k);
        const xl = this.x0 + l * this.lw, xr = xl + n.w * this.lw;
        if (x < xl - 3 || x > xr + 3) continue;
        const d = Math.min(Math.abs(y - yh), Math.abs(y - ye)) * 0.5;
        if (d < bd) { bd = d; best = n; }
      } else {
        if (Math.abs(y - yh) > 9) continue;
        const xl = this.x0 + n.lane * this.lw, xr = xl + n.w * this.lw;
        if (x < xl - 3 || x > xr + 3) continue;
        const d = Math.abs(y - yh);
        if (d < bd) { bd = d; best = n; }
      }
    }
    return best;
  }
  eraseAt(x, y) {
    const n = this.hitTest(x, y);
    if (!n) return;
    this.pushUndo();
    this.chart.notes.splice(this.chart.notes.indexOf(n), 1);
    this._stats();
  }

  _pos(e) { const r = this.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  _down(e) {
    e.preventDefault();
    this.app.engine.ensure();
    const { x, y } = this._pos(e);
    try { this.cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (e.button === 1 || this.tool === 'pan' || x < this.x0 - 4 || x > this.x0 + this.lw * 12 + 4) {
      this.drag = { mode: 'pan', y0: y, v0: this.viewT }; return;
    }
    if (e.button === 2 || this.tool === 'erase') { this.eraseAt(x, y); return; }
    const t = this.snapT(this.timeAtY(y));
    const w = this.width, lane = this.laneFromX(x, w);
    if (this.tool === 'tap' || this.tool === 'flick') {
      this.addNote(this.newNote(this.tool, t, lane, w));
      if (this.app.engine.ctx) this.app.engine.playSE(this.tool === 'flick' ? 'flick' : 'perfect', 0.5);
    } else if (this.tool === 'hold') {
      this.drag = { mode: 'hold', t0: t, lane, end: t + this.snapStep, endLane: lane };
    }
  }
  _move(e) {
    const { x, y } = this._pos(e);
    this.hover = { x, y };
    const d = this.drag;
    if (!d) return;
    if (d.mode === 'pan') this.seek(d.v0 + (y - d.y0) / this.pps);
    else if (d.mode === 'hold') {
      d.end = Math.max(d.t0 + this.snapStep, this.snapT(this.timeAtY(y)));
      d.endLane = this.laneFromX(x, this.width);
    }
  }
  _up() {
    const d = this.drag; this.drag = null;
    if (!d || d.mode !== 'hold') return;
    const n = this.newNote('hold', d.t0, d.lane, this.width);
    n.end = +d.end.toFixed(4); n.endLane = d.endLane;
    if (this.endFlick) n.endFlick = true;
    this.addNote(n);
  }

  _isTyping(e) { const t = e.target; return t && (t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'range' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA'); }
  _key(e) {
    if (!this.active || this._isTyping(e)) return;
    const keys = Settings.data.keys;
    const col = keys.indexOf(e.code);
    if (this.rec && col >= 0 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      if (!e.repeat && this.source.playing && this.recDown[col] == null) this.recDown[col] = this.source.time() - Settings.offsetFor(this.source.kind);
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.code === 'KeyZ') { e.preventDefault(); this.undo(); return; }
    if (mod && e.code === 'KeyS') { e.preventDefault(); this.save(); return; }
    if (mod) return;
    const toolKeys = { Digit1: 'tap', Digit2: 'flick', Digit3: 'hold', Digit4: 'erase', Digit5: 'pan' };
    if (toolKeys[e.code]) { this.tool = toolKeys[e.code]; this._syncUI(); return; }
    if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); return; }
    if (e.code === 'KeyC') { this.crit = !this.crit; this._syncUI(); return; }
    if (e.code === 'ArrowUp') { e.preventDefault(); this.seek(this.snapT(this.viewT) + this.snapStep); return; }
    if (e.code === 'ArrowDown') { e.preventDefault(); this.seek(this.snapT(this.viewT) - this.snapStep); return; }
    if (e.code === 'PageUp') { e.preventDefault(); this.seek(this.viewT + this.beat * 4); return; }
    if (e.code === 'PageDown') { e.preventDefault(); this.seek(this.viewT - this.beat * 4); return; }
    if (e.code === 'Home') { this.seek(0); return; }
  }
  _keyUp(e) {
    if (!this.active || !this.rec) return;
    const col = Settings.data.keys.indexOf(e.code);
    if (col < 0 || this.recDown[col] == null) return;
    const t0 = this.recDown[col]; delete this.recDown[col];
    const t1 = this.source.time() - Settings.offsetFor(this.source.kind);
    const w = this.width;
    const lane = U.clamp(Math.round(col * 2 + 1 - w / 2), 0, 12 - w);
    const s0 = this.snapT(t0), s1 = this.snapT(t1);
    let n;
    if (t1 - t0 >= 0.28 && s1 - s0 >= this.snapStep - 1e-6) {
      n = this.newNote('hold', s0, lane, w); n.end = +s1.toFixed(4); n.endLane = lane;
      if (this.endFlick) n.endFlick = true;
    } else n = this.newNote(this.tool === 'flick' ? 'flick' : 'tap', s0, lane, w);
    this.addNote(n);
  }

  async autoGen() {
    if (this.chart.notes.length && !confirm(`${DIFF_LABEL[this.diff]} の譜面を自動生成で上書きしますか？`)) return;
    try {
      const src = await this.app.autoEvents(this.song, this.source, this.bpm, this.offset, this.duration);
      const c = ChartGen.generate({ bpm: this.bpm, offset: this.offset, duration: this.duration, events: src.events }, this.diff, U.hashStr(this.song.id + this.diff) + Date.now() % 1000);
      this.pushUndo();
      this.chart.notes = c.notes;
      this.chart.level = null;
      this._syncUI();
      this.app.toast(`${DIFF_LABEL[this.diff]} を自動生成しました (${c.notes.length} ノーツ)`);
    } catch (err) { this.app.toast('自動生成に失敗: ' + err.message); }
  }

  exportCharts() {
    const out = {};
    for (const d of DIFFS) {
      const c = this.charts[d];
      out[d] = { bpm: this.bpm, offset: this.offset, notes: c.notes, level: c.level || ChartGen.calcLevel({ notes: c.notes }) };
    }
    return out;
  }
  async save() {
    this.song.bpm = this.bpm; this.song.offset = this.offset;
    this.song.charts = this.exportCharts();
    this.song.updatedAt = Date.now();
    try {
      await DB.put(this.song);
      this.dirty = false;
      this.app.toast('保存しました');
      this.app.onSongSaved(this.song);
    } catch (err) { this.app.toast('保存に失敗: ' + err.message); }
  }
  testPlay() {
    if (!this.chart.notes.length) { this.app.toast('ノーツがありません'); return; }
    const startAt = this.viewT > 1 ? this.viewT : 0;
    this.deactivate();
    const chart = { bpm: this.bpm, offset: this.offset, notes: this.chart.notes, level: this.chart.level || ChartGen.calcLevel({ notes: this.chart.notes }) };
    this.app.startGame({ song: this.song, diff: this.diff, chart, source: this.source, startAt, fromEditor: true });
  }

  /* ---------- 描画 ---------- */
  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cv.width = Math.max(1, Math.round(r.width * dpr)); this.cv.height = Math.max(1, Math.round(r.height * dpr));
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = r.width; this.H = r.height;
    this.playY = this.H * 0.82;
    const left = 92;
    const area = Math.max(240, Math.min(this.W - left - 16, 620));
    this.lw = area / 12;
    this.x0 = left + Math.max(0, (this.W - left - 16 - area) / 2);
  }
  yAt(t) { return this.playY - (t - this.viewT) * this.pps; }
  timeAtY(y) { return this.viewT + (this.playY - y) / this.pps; }

  _frame() {
    if (this.source.playing) {
      this.viewT = this.source.time();
      if ($('#ed-ticks').checked) {
        const ns = this.chart.notes;
        const from = this.lastTick ?? this.viewT;
        if (this.viewT > from) {
          let ticked = false;
          for (const n of ns) { if (n.t > from && n.t <= this.viewT) { ticked = true; break; } }
          if (ticked) this.app.engine.playSE('tick', 1);
        }
      }
      this.lastTick = this.viewT;
    } else if ($('#ed-play').textContent !== '▶') $('#ed-play').textContent = '▶';
    if (this.W !== this.cv.getBoundingClientRect().width) this.resize();
    this.draw();
    $('#ed-time').textContent = U.fmtTime(this.viewT) + ' / ' + U.fmtTime(this.duration);
    if (document.activeElement !== $('#ed-seek')) $('#ed-seek').value = Math.round(U.clamp(this.viewT / this.duration, 0, 1) * 1000);
  }

  draw() {
    const g = this.g, W = this.W, H = this.H, x0 = this.x0, lw = this.lw, x1 = x0 + lw * 12;
    g.fillStyle = '#090a18'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#10122a'; g.fillRect(x0, 0, x1 - x0, H);
    // 波形
    if (this.peaks) {
      const cx = 66, pk = this.peaks;
      g.fillStyle = 'rgba(54,226,255,0.35)';
      for (let y = 0; y < H; y += 2) {
        const i = Math.floor(this.timeAtY(y) * 200);
        if (i < 0 || i >= pk.length) continue;
        const a = pk[i] * 24;
        g.fillRect(cx - a, y, a * 2, 2);
      }
    }
    // レーン線
    for (let i = 0; i <= 12; i++) {
      g.strokeStyle = i % 2 === 0 ? (i === 0 || i === 12 ? 'rgba(170,220,255,0.6)' : 'rgba(255,255,255,0.16)') : 'rgba(255,255,255,0.05)';
      g.lineWidth = i === 0 || i === 12 ? 2 : 1;
      g.beginPath(); g.moveTo(x0 + i * lw, 0); g.lineTo(x0 + i * lw, H); g.stroke();
    }
    // グリッド
    const tA = this.timeAtY(H), tB = this.timeAtY(0), st = this.snapStep, beat = this.beat;
    const k0 = Math.ceil((tA - this.offset) / st), k1 = Math.floor((tB - this.offset) / st);
    g.font = '11px ui-monospace, monospace'; g.textAlign = 'right'; g.textBaseline = 'middle';
    if (k1 - k0 < 4000) {
      for (let k = k0; k <= k1; k++) {
        const t = this.offset + k * st, y = this.yAt(t);
        const bp = (t - this.offset) / beat, isBeat = Math.abs(bp - Math.round(bp)) < 1e-6;
        const bi = Math.round(bp), isBar = isBeat && ((bi % 4) + 4) % 4 === 0;
        g.strokeStyle = isBar ? 'rgba(255,255,255,0.55)' : isBeat ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.07)';
        g.lineWidth = isBar ? 1.5 : 1;
        g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
        if (isBar) {
          g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillText('#' + (Math.floor(bi / 4) + 1), 40, y);
          g.fillStyle = 'rgba(255,255,255,0.4)'; g.fillText(U.fmtTime(t).slice(0, -1), x0 - 6, y - 8);
        }
      }
    }
    // ノーツ
    const ns = this.chart.notes;
    const vis = n => (n.end || n.t) >= tA - 0.1 && n.t <= tB + 0.1;
    for (const n of ns) if (n.type === 'hold' && vis(n)) this._drawHold(n, 1);
    for (const n of ns) if (vis(n)) this._drawNote(n.type, n.crit, n.lane, n.w, n.t, n.dir, 1);
    // ロング作成中
    if (this.drag && this.drag.mode === 'hold') {
      const d = this.drag;
      const tmp = { t: d.t0, end: d.end, lane: d.lane, endLane: d.endLane, w: this.width, type: 'hold', crit: this.crit, endFlick: this.endFlick };
      this._drawHold(tmp, 0.7);
      this._drawNote('hold', this.crit, d.lane, this.width, d.t0, null, 0.7);
    } else if (this.hover && (this.tool === 'tap' || this.tool === 'flick' || this.tool === 'hold') && this.hover.x >= x0 && this.hover.x <= x1) {
      const t = this.snapT(this.timeAtY(this.hover.y));
      this._drawNote(this.tool, this.crit, this.laneFromX(this.hover.x, this.width), this.width, t, this.dir, 0.35);
    }
    // 再生ライン
    g.strokeStyle = this.rec && this.source.playing ? '#ff4d6d' : '#36e2ff'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(x0 - 20, this.playY); g.lineTo(x1 + 20, this.playY); g.stroke();
    g.fillStyle = g.strokeStyle; g.textAlign = 'left';
    g.fillText(U.fmtTime(this.viewT), x1 + 6, this.playY - 10);
    if (this.rec) { g.fillStyle = '#ff4d6d'; g.font = '700 13px system-ui'; g.fillText('● REC', x1 + 6, this.playY + 12); }
  }

  _colors(type, crit, tail, endFlick) {
    if (crit) return NOTE_COLORS.crit;
    if (tail) return endFlick ? NOTE_COLORS.flick : NOTE_COLORS.hold;
    return NOTE_COLORS[type] || NOTE_COLORS.tap;
  }
  _drawNote(type, crit, lane, w, t, dir, alpha) {
    const g = this.g, y = this.yAt(t), x = this.x0 + lane * this.lw + 2, ww = w * this.lw - 4, h = 12;
    if (y < -20 || y > this.H + 20) return;
    const c = this._colors(type, crit);
    g.globalAlpha = alpha;
    g.fillStyle = c[1]; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    g.beginPath(); g.roundRect ? g.roundRect(x, y - h / 2, ww, h, 5) : g.rect(x, y - h / 2, ww, h); g.fill(); g.stroke();
    if (type === 'flick') {
      const cx = x + ww / 2, ang = dir === 'left' ? -0.6 : dir === 'right' ? 0.6 : 0;
      g.save(); g.translate(cx, y - h - 2); g.rotate(ang);
      g.fillStyle = c[1]; g.beginPath(); g.moveTo(0, -8); g.lineTo(8, 4); g.lineTo(-8, 4); g.closePath(); g.fill(); g.stroke();
      g.restore();
    }
    g.globalAlpha = 1;
  }
  _drawHold(n, alpha) {
    const g = this.g, lw = this.lw, x0 = this.x0;
    const y0 = this.yAt(n.t), y1 = this.yAt(n.end);
    const el = n.endLane ?? n.lane;
    g.globalAlpha = alpha;
    g.fillStyle = n.crit ? 'rgba(255,207,58,0.35)' : 'rgba(80,240,150,0.35)';
    g.beginPath();
    g.moveTo(x0 + n.lane * lw + 4, y0); g.lineTo(x0 + (n.lane + n.w) * lw - 4, y0);
    g.lineTo(x0 + (el + n.w) * lw - 4, y1); g.lineTo(x0 + el * lw + 4, y1); g.closePath(); g.fill();
    g.globalAlpha = 1;
    // 終点
    const c = this._colors('hold', n.crit, true, n.endFlick);
    const x = x0 + el * lw + 2, ww = n.w * lw - 4;
    g.globalAlpha = alpha;
    g.fillStyle = c[1]; g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 1;
    g.fillRect(x, y1 - 4, ww, 8); g.strokeRect(x, y1 - 4, ww, 8);
    if (n.endFlick) {
      g.save(); g.translate(x + ww / 2, y1 - 10);
      g.fillStyle = NOTE_COLORS.flick[1]; g.beginPath(); g.moveTo(0, -7); g.lineTo(7, 3); g.lineTo(-7, 3); g.closePath(); g.fill();
      g.restore();
    }
    g.globalAlpha = 1;
  }
}
