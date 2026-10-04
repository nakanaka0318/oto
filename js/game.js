'use strict';
/*
 * ゲームエンジン (プロセカ風 12分割レーン / 遠近法プレイフィールド)
 *  ノーツ: タップ / フリック / ロング(スライド・終点フリック対応) / クリティカル
 *  入力: タッチ・マウス (Pointer Events) / キーボード (6キー)
 */
const JUDGE_NAMES = ['PERFECT', 'GREAT', 'GOOD', 'BAD', 'MISS'];
const JUDGE_COLORS = ['#ff8ae2', '#ffb347', '#57c8ff', '#7be07b', '#a0a4b8'];
const WINDOWS = [0.042, 0.083, 0.108, 0.125];
const WEIGHTS = [1, 0.8, 0.5, 0.2, 0];
const NOTE_COLORS = {
  tap: ['#7ff6ff', '#21c7e8'], hold: ['#9dffbd', '#2fd87a'], flick: ['#ff9ad1', '#ff3d97'], crit: ['#fff09a', '#ffbf1f'],
};

class Game {
  constructor(o) {
    this.cv = o.canvas; this.g = this.cv.getContext('2d');
    this.engine = o.engine; this.source = o.source; this.info = o.info || {};
    this.S = Settings.data;
    this.auto = !!(this.S.auto || o.auto);
    this.startAt = o.startAt || 0;
    this.onEnd = o.onEnd || (() => {}); this.onPause = o.onPause || (() => {});
    this.ytBg = this.source.kind === 'youtube';
    this.offset = (this.S.offset || 0) / 1000;
    this.visible = 0.25 + (12.5 - U.clamp(this.S.speed, 1, 12)) * 0.2;
    this.notes = (o.chart.notes || []).filter(n => n.t >= this.startAt - 1e-6).map((n, i) => ({
      ...n, id: i, hj: null, tj: null, st: n.type === 'hold' ? 'pending' : null, done: false, claimed: null,
      endLane: n.type === 'hold' ? (n.endLane ?? n.lane) : undefined,
    })).sort((a, b) => a.t - b.t);
    this.total = this.notes.reduce((a, n) => a + (n.type === 'hold' ? 2 : 1), 0) || 1;
    this.lastT = this.notes.reduce((a, n) => Math.max(a, n.end || n.t), 0);
    this.cnt = [0, 0, 0, 0, 0];
    this.combo = 0; this.maxCombo = 0; this.sumW = 0; this.life = 1000; this.fast = 0; this.late = 0;
    this.scan = 0; this.ptrs = new Map(); this.fx = []; this.jDisp = null; this.comboAt = 0;
    this.running = false; this.paused = false; this.finishing = false;
    this.bpm = o.chart.bpm || 120; this.chartOffset = o.chart.offset || 0;
    this.colors = this.info.colors || ['#22d3ee', '#a855f7'];
    this._bind();
  }

  /* ---------- ライフサイクル ---------- */
  start() {
    this.engine.ensure();
    this.resize();
    let from = this.startAt > 0 ? this.startAt - 2 : -2.2;
    if (this.ytBg) from = Math.max(0, from);
    this.source.play(from);
    this.running = true; this.paused = false;
    window.addEventListener('resize', this._onResize);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('visibilitychange', this._onVis);
    this.cv.addEventListener('pointerdown', this._onDown);
    this.cv.addEventListener('pointermove', this._onMove);
    this.cv.addEventListener('pointerup', this._onUp);
    this.cv.addEventListener('pointercancel', this._onUp);
    this.cv.addEventListener('contextmenu', this._prevent);
    this.raf = requestAnimationFrame(this._loop);
  }
  destroy() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    try { this.source.pause(); } catch (e) { /* ignore */ }
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('visibilitychange', this._onVis);
    this.cv.removeEventListener('pointerdown', this._onDown);
    this.cv.removeEventListener('pointermove', this._onMove);
    this.cv.removeEventListener('pointerup', this._onUp);
    this.cv.removeEventListener('pointercancel', this._onUp);
    this.cv.removeEventListener('contextmenu', this._prevent);
  }
  pause() {
    if (this.paused || !this.running || this.finishing) return;
    this.paused = true;
    this.source.pause();
    this.ptrs.clear();
    this.onPause();
  }
  resume() {
    if (!this.paused) return;
    this.paused = false;
    const back = Math.max(this.source.pos - 1.5, this.ytBg ? 0 : -2);
    this.source.play(back);
  }

  _bind() {
    this._prevent = e => e.preventDefault();
    this._onResize = () => this.resize();
    this._onVis = () => { if (document.hidden) this.pause(); };
    this._loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(this._loop);
      const perf = performance.now();
      const now = this.time(perf);
      if (!this.paused) this.update(now);
      this.draw(now, perf);
    };
    this._onDown = e => {
      e.preventDefault();
      if (this.paused || this.auto) return;
      this.engine.ensure();
      try { this.cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      const tt = this.time(e.timeStamp);
      const lp = this.laneAt(e.clientX, e.clientY);
      const p = { id: e.pointerId, key: false, x: e.clientX, y: e.clientY, lp, ax: e.clientX, ay: e.clientY, at: performance.now(), flick: null };
      this.ptrs.set(e.pointerId, p);
      this.press(p, tt);
    };
    this._onMove = e => {
      const p = this.ptrs.get(e.pointerId);
      if (!p || this.paused) return;
      p.x = e.clientX; p.y = e.clientY; p.lp = this.laneAt(e.clientX, e.clientY);
      const dist = Math.hypot(p.x - p.ax, p.y - p.ay);
      const pn = performance.now();
      if (dist >= this.flickDist) {
        this.flickAction(p, this.time(e.timeStamp));
        p.ax = p.x; p.ay = p.y; p.at = pn;
      } else if (pn - p.at > 110) { p.ax = p.x; p.ay = p.y; p.at = pn; }
    };
    this._onUp = e => {
      const p = this.ptrs.get(e.pointerId);
      if (!p) return;
      this.ptrs.delete(e.pointerId);
      if (this.paused) return;
      this.releasePtr(p, this.time(e.timeStamp));
    };
    this._onKeyDown = e => {
      const col = this.S.keys.indexOf(e.code);
      if (col < 0) {
        if (e.code === 'Escape' || e.code === 'KeyP') { e.preventDefault(); this.pause(); }
        return;
      }
      e.preventDefault();
      if (e.repeat || this.paused || this.auto) return;
      this.engine.ensure();
      const id = 'k' + col;
      if (this.ptrs.has(id)) return;
      const p = { id, key: true, col, lp: col * 2 + 1, flick: null };
      this.ptrs.set(id, p);
      this.press(p, this.time(e.timeStamp));
    };
    this._onKeyUp = e => {
      const col = this.S.keys.indexOf(e.code);
      if (col < 0) return;
      const p = this.ptrs.get('k' + col);
      if (!p) return;
      this.ptrs.delete(p.id);
      if (this.paused) return;
      this.releasePtr(p, this.time(e.timeStamp), true);
    };
  }

  time(perf) { return this.source.timeAt(perf) - this.offset; }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth, h = window.innerHeight;
    this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
    this.cv.style.width = w + 'px'; this.cv.style.height = h + 'px';
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w; this.H = h;
    this.cx = w / 2;
    this.yJ = h * 0.84;
    this.vpY = -h * 0.25;
    this.hwJ = Math.min(w * (w < h ? 0.47 : 0.42), h * 0.88);
    this.D = (this.yJ - this.vpY) / (h * 0.04 - this.vpY) - 1;
    this.noteH = Math.max(14, h * 0.046) * (this.S.noteSize || 1);
    this.flickDist = Math.max(14, h * 0.028);
  }
  proj(p) { const s = 1 / (1 + this.D * p); return { s, y: this.vpY + (this.yJ - this.vpY) * s }; }
  xAt(lp, s) { return this.cx + (lp / 6 - 1) * this.hwJ * s; }
  laneAt(x, y) {
    const yy = U.clamp(y, this.yJ - this.H * 0.45, this.H);
    const s = (yy - this.vpY) / (this.yJ - this.vpY);
    return ((x - this.cx) / (this.hwJ * s) + 1) * 6;
  }
  ptrRange(p, tol) { return p.key ? [p.col * 2, p.col * 2 + 2] : [p.lp - tol, p.lp + tol]; }
  laneRangeAt(n, t) {
    if (n.type !== 'hold') return [n.lane, n.lane + n.w];
    const k = n.end > n.t ? U.clamp((t - n.t) / (n.end - n.t), 0, 1) : 0;
    const l = U.lerp(n.lane, n.endLane, k);
    return [l, l + n.w];
  }
  static overlap(a, b) { return a[0] < b[1] && a[1] > b[0]; }

  /* ---------- 判定 ---------- */
  judgeOf(d) { d = Math.abs(d); return d <= WINDOWS[0] ? 0 : d <= WINDOWS[1] ? 1 : d <= WINDOWS[2] ? 2 : d <= WINDOWS[3] ? 3 : 4; }

  press(p, tt) {
    const range = this.ptrRange(p, 0.75);
    let hit = null;
    for (let i = this.scan; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t - tt > WINDOWS[3]) break;
      if (n.done || n.hj != null || n.claimed != null) continue;
      if (tt - n.t > WINDOWS[3]) continue;
      if (!Game.overlap(range, [n.lane, n.lane + n.w])) continue;
      hit = n; break;
    }
    if (!hit) return;
    if (hit.type === 'flick' && !p.key) { hit.claimed = p.id; p.flick = hit; return; }
    this.applyJudge(hit, 'head', this.judgeOf(tt - hit.t), tt - hit.t);
    if (hit.type === 'hold') hit.st = 'holding';
    else hit.done = true;
  }

  flickAction(p, tt) {
    if (p.flick) {
      const n = p.flick;
      if (!n.done && n.hj == null && Math.abs(tt - n.t) <= WINDOWS[3]) {
        n.claimed = null; p.flick = null;
        this.applyJudge(n, 'head', this.judgeOf(tt - n.t), tt - n.t);
        n.done = true;
        return;
      }
      if (n.done || tt - n.t > WINDOWS[3]) { n.claimed = null; p.flick = null; }
    }
    const range = this.ptrRange(p, 0.75);
    for (let i = this.scan; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t - tt > WINDOWS[3]) break;
      if (n.done) continue;
      if (n.type === 'flick' && n.hj == null && n.claimed == null && Math.abs(tt - n.t) <= WINDOWS[3] && Game.overlap(range, [n.lane, n.lane + n.w])) {
        this.applyJudge(n, 'head', this.judgeOf(tt - n.t), tt - n.t);
        n.done = true;
        return;
      }
      if (n.type === 'hold' && n.endFlick && n.st === 'holding' && Math.abs(tt - n.end) <= WINDOWS[3] &&
        Game.overlap(this.ptrRange(p, 1.2), this.laneRangeAt(n, tt))) {
        this.applyJudge(n, 'tail', this.judgeOf(tt - n.end), tt - n.end);
        n.done = true;
        return;
      }
    }
  }

  releasePtr(p, tt) {
    if (p.flick) { p.flick.claimed = null; p.flick = null; }
    for (let i = this.scan; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.t > tt + WINDOWS[3]) break;
      if (n.done || n.type !== 'hold' || n.st !== 'holding') continue;
      if (!this.covered(n, tt)) this.releaseHold(n, tt);
    }
  }

  covered(n, t) {
    const r = this.laneRangeAt(n, U.clamp(t, n.t, n.end));
    for (const p of this.ptrs.values()) if (Game.overlap(this.ptrRange(p, 1.3), r)) return true;
    return false;
  }

  releaseHold(n, tt) {
    const d = tt - n.end;
    if (d >= -WINDOWS[2]) {
      this.applyJudge(n, 'tail', this.judgeOf(d), d);
      n.done = true;
    } else n.st = 'released';
  }

  applyJudge(n, part, j, diff) {
    if (part === 'head') n.hj = j; else n.tj = j;
    this.cnt[j]++;
    if (j <= 1) { this.combo++; if (this.combo > this.maxCombo) this.maxCombo = this.combo; this.comboAt = performance.now(); }
    else this.combo = 0;
    this.sumW += WEIGHTS[j];
    if (j === 4) this.life = Math.max(0, this.life - (part === 'tail' ? 40 : 70));
    else if (j === 3) this.life = Math.max(0, this.life - 35);
    if (j > 0 && j < 4) { if (diff < 0) this.fast++; else this.late++; }
    this.jDisp = { j, at: performance.now(), fl: j > 0 && j < 4 ? (diff < 0 ? 'FAST' : 'LATE') : '' };
    if (j < 4) {
      const lane = part === 'tail' ? n.endLane : n.lane;
      const isFlick = n.type === 'flick' || (part === 'tail' && n.endFlick);
      const kind = n.crit ? 'crit' : isFlick ? 'flick' : n.type === 'hold' ? 'hold' : 'tap';
      if (this.S.effects !== false) this.fx.push({ lp: lane + n.w / 2, w: n.w, kind, j, at: performance.now(), seed: Math.random() });
      const se = n.crit ? 'crit' : isFlick ? 'flick' : j === 0 ? 'perfect' : j === 1 ? 'great' : 'good';
      this.engine.playSE(se, 1);
    }
  }

  update(now) {
    const ns = this.notes;
    if (this.auto) {
      for (let i = this.scan; i < ns.length; i++) {
        const n = ns[i];
        if (n.t > now) break;
        if (n.done) continue;
        if (n.hj == null) { this.applyJudge(n, 'head', 0, 0); if (n.type === 'hold') n.st = 'holding'; else n.done = true; }
        if (n.type === 'hold' && !n.done && now >= n.end) { this.applyJudge(n, 'tail', 0, 0); n.done = true; }
      }
    }
    for (let i = this.scan; i < ns.length; i++) {
      const n = ns[i];
      if (n.t > now + 0.2) break;
      if (n.done) continue;
      if (n.hj == null && now - n.t > WINDOWS[3]) {
        if (n.claimed != null) { const p = this.ptrs.get(n.claimed); if (p) p.flick = null; n.claimed = null; }
        this.applyJudge(n, 'head', 4, 1);
        if (n.type === 'hold') n.st = 'released'; else { n.done = true; continue; }
      }
      if (n.type === 'hold' && n.hj != null && !this.auto) {
        const cov = this.covered(n, now);
        if (n.st === 'holding') {
          if (!cov) this.releaseHold(n, now);
          else if (now >= n.end && !n.endFlick) { this.applyJudge(n, 'tail', 0, 0); n.done = true; }
        } else if (n.st === 'released' && cov && now >= n.t && now < n.end - 0.06) n.st = 'holding';
        if (!n.done && now - n.end > WINDOWS[3]) { this.applyJudge(n, 'tail', 4, 1); n.done = true; }
      }
    }
    while (this.scan < ns.length && ns[this.scan].done) this.scan++;
    // 終了判定
    if (!this.finishing && this.scan >= ns.length && (now > this.lastT + 1.2 || this.source.ended)) {
      this.finishing = true;
      setTimeout(() => this.finish(), 1200);
    }
  }

  result() {
    const score = Math.round(1000000 * this.sumW / this.total);
    const c = this.cnt;
    const all = c.reduce((a, b) => a + b, 0) >= this.total;
    const rank = score >= 980000 ? 'SS' : score >= 940000 ? 'S' : score >= 880000 ? 'A' : score >= 780000 ? 'B' : score >= 650000 ? 'C' : 'D';
    return {
      score, rank, cnt: c.slice(), maxCombo: this.maxCombo, total: this.total, fast: this.fast, late: this.late,
      fc: all && c[2] + c[3] + c[4] === 0, ap: all && c[0] === this.total, clear: this.life > 0, auto: this.auto, partial: this.startAt > 0,
    };
  }
  finish() {
    if (!this.running) return;
    const r = this.result();
    this.destroy();
    this.onEnd(r);
  }

  /* ---------- 描画 ---------- */
  draw(now, perf) {
    const g = this.g, W = this.W, H = this.H;
    g.clearRect(0, 0, W, H);
    this.drawBackground(now, perf);
    this.drawLane(now);
    this.drawCombo(perf);
    this.drawNotes(now, perf);
    this.drawJudgeLine(perf);
    this.drawEffects(perf);
    this.drawHUD(now, perf);
  }

  drawBackground(now) {
    const g = this.g, W = this.W, H = this.H;
    if (this.ytBg) { g.fillStyle = 'rgba(6,6,18,0.55)'; g.fillRect(0, 0, W, H); return; }
    const grd = g.createLinearGradient(0, 0, W, H);
    grd.addColorStop(0, '#0a0b1e'); grd.addColorStop(0.5, '#120a26'); grd.addColorStop(1, '#06121e');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    // 拍に合わせて光るグロー
    const beat = 60 / this.bpm;
    const ph = now > 0 ? (((now - this.chartOffset) / beat) % 1 + 1) % 1 : 1;
    const pulse = Math.exp(-ph * 5);
    const rg = g.createRadialGradient(W / 2, H * 0.1, 0, W / 2, H * 0.1, Math.max(W, H) * 0.7);
    rg.addColorStop(0, this.hexA(this.colors[0], 0.16 + pulse * 0.14));
    rg.addColorStop(0.5, this.hexA(this.colors[1], 0.08 + pulse * 0.05));
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(0, 0, W, H);
  }
  hexA(hex, a) {
    const v = parseInt(hex.slice(1), 16);
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
  }

  drawLane() {
    const g = this.g;
    const top = this.proj(1), bot = this.proj(-0.06);
    const pts = [[this.xAt(0, top.s), top.y], [this.xAt(12, top.s), top.y], [this.xAt(12, bot.s), bot.y], [this.xAt(0, bot.s), bot.y]];
    const grd = g.createLinearGradient(0, top.y, 0, bot.y);
    grd.addColorStop(0, 'rgba(10,12,34,0.15)'); grd.addColorStop(0.35, 'rgba(10,12,34,0.72)'); grd.addColorStop(1, 'rgba(10,12,34,0.9)');
    g.fillStyle = grd;
    g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath(); g.fill();
    // 押下中レーンの光
    for (const p of this.ptrs.values()) {
      const [a, b] = p.key ? [p.col * 2, p.col * 2 + 2] : [Math.floor(p.lp) - 0.5, Math.floor(p.lp) + 1.5];
      if (b < 0 || a > 12) continue;
      const aa = U.clamp(a, 0, 12), bb = U.clamp(b, 0, 12);
      const t2 = this.proj(0.55);
      const lg = g.createLinearGradient(0, this.yJ, 0, t2.y);
      lg.addColorStop(0, 'rgba(120,220,255,0.35)'); lg.addColorStop(1, 'rgba(120,220,255,0)');
      g.fillStyle = lg;
      g.beginPath();
      g.moveTo(this.xAt(aa, 1), this.yJ); g.lineTo(this.xAt(bb, 1), this.yJ);
      g.lineTo(this.xAt(bb, t2.s), t2.y); g.lineTo(this.xAt(aa, t2.s), t2.y); g.closePath(); g.fill();
    }
    // 区切り線
    for (let i = 0; i <= 12; i += 2) {
      const edge = i === 0 || i === 12;
      const lg = g.createLinearGradient(0, top.y, 0, bot.y);
      lg.addColorStop(0, 'rgba(255,255,255,0)');
      lg.addColorStop(0.4, edge ? 'rgba(170,220,255,0.7)' : 'rgba(255,255,255,0.13)');
      lg.addColorStop(1, edge ? 'rgba(170,220,255,0.9)' : 'rgba(255,255,255,0.18)');
      g.strokeStyle = lg; g.lineWidth = edge ? 2.5 : 1;
      g.beginPath(); g.moveTo(this.xAt(i, top.s), top.y); g.lineTo(this.xAt(i, bot.s), bot.y); g.stroke();
    }
    // キー表示
    if (this.S.showKeys && !this.auto && !('ontouchstart' in window)) {
      g.font = `600 ${Math.max(11, this.H * 0.022)}px system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'top'; g.fillStyle = 'rgba(255,255,255,0.35)';
      this.S.keys.forEach((k, i) => g.fillText(k.replace(/^Key|^Digit/, ''), this.xAt(i * 2 + 1, 1.05), this.yJ + this.H * 0.045));
    }
  }

  drawJudgeLine(perf) {
    const g = this.g, y = this.yJ;
    const x0 = this.xAt(0, 1), x1 = this.xAt(12, 1);
    g.save();
    g.shadowColor = 'rgba(140,220,255,0.9)'; g.shadowBlur = 14;
    const lg = g.createLinearGradient(x0, 0, x1, 0);
    lg.addColorStop(0, 'rgba(140,220,255,0.6)'); lg.addColorStop(0.5, 'rgba(255,255,255,0.95)'); lg.addColorStop(1, 'rgba(140,220,255,0.6)');
    g.strokeStyle = lg; g.lineWidth = 3;
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    g.restore();
  }

  noteColor(n, tail) {
    if (n.crit) return NOTE_COLORS.crit;
    if (tail) return n.endFlick ? NOTE_COLORS.flick : NOTE_COLORS.hold;
    return NOTE_COLORS[n.type];
  }

  drawNotes(now, perf) {
    const ns = this.notes, vis = this.visible, g = this.g;
    const heads = [], tails = [];
    const pMin = -0.08;
    for (let i = this.scan; i < ns.length; i++) {
      const n = ns[i];
      if (n.t > now + vis) break;
      if (n.done) continue;
      if (n.type === 'hold') {
        const holding = n.st === 'holding';
        const t0 = holding ? Math.max(now, n.t) : Math.max(n.t, now + pMin * vis);
        const t1 = Math.min(n.end, now + vis);
        if (t1 > t0) this.drawHoldBody(n, t0, t1, now, holding, perf);
        if (n.end <= now + vis) tails.push(n);
        if (holding || (n.hj != null && n.t < now)) {
          if (holding) heads.push({ n, p: 0, held: true });
        } else if ((n.t - now) / vis >= pMin) heads.push({ n, p: (n.t - now) / vis });
      } else {
        const p = (n.t - now) / vis;
        if (p >= pMin) heads.push({ n, p });
      }
    }
    for (const n of tails) {
      const p = Math.max((n.end - now) / vis, n.st === 'holding' ? 0 : pMin);
      this.drawNote(n.endLane, n.w, p, this.noteColor(n, true), n.endFlick ? 'up' : null, perf, 0.8);
    }
    for (let i = heads.length - 1; i >= 0; i--) {
      const h = heads[i], n = h.n;
      const lane = h.held ? this.laneRangeAt(n, now)[0] : n.lane;
      this.drawNote(lane, n.w, h.p, this.noteColor(n, false), n.type === 'flick' ? n.dir || 'up' : null, perf, 1, h.held);
    }
  }

  drawHoldBody(n, t0, t1, now, holding, perf) {
    const g = this.g, vis = this.visible;
    const N = 18, L = [], R = [];
    for (let k = 0; k <= N; k++) {
      const t = t0 + (t1 - t0) * k / N;
      const pr = this.proj((t - now) / vis);
      const [a, b] = this.laneRangeAt(n, t);
      L.push([this.xAt(a + 0.25, pr.s), pr.y]);
      R.push([this.xAt(b - 0.25, pr.s), pr.y]);
    }
    const col = n.crit ? [255, 214, 80] : [80, 240, 150];
    const alpha = holding ? 0.55 + 0.12 * Math.sin(perf / 70) : n.st === 'released' ? 0.22 : 0.42;
    const grd = g.createLinearGradient(0, L[N][1], 0, L[0][1]);
    grd.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${alpha * 0.6})`);
    grd.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},${alpha})`);
    g.fillStyle = grd;
    g.beginPath();
    L.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]));
    for (let i = R.length - 1; i >= 0; i--) g.lineTo(R[i][0], R[i][1]);
    g.closePath(); g.fill();
    // 中央線
    g.strokeStyle = `rgba(255,255,255,${alpha * 0.6})`; g.lineWidth = 2;
    g.beginPath();
    L.forEach((p, i) => { const x = (p[0] + R[i][0]) / 2; i ? g.lineTo(x, p[1]) : g.moveTo(x, p[1]); });
    g.stroke();
  }

  drawNote(lane, w, p, colors, arrow, perf, scale = 1, glow = false) {
    const g = this.g;
    const pr = this.proj(p);
    const xl = this.xAt(lane + 0.06, pr.s), xr = this.xAt(lane + w - 0.06, pr.s);
    const h = this.noteH * pr.s * scale;
    const y = pr.y;
    const r = Math.min(h / 2, (xr - xl) / 2);
    g.save();
    if (glow) { g.shadowColor = colors[1]; g.shadowBlur = 18; }
    const grd = g.createLinearGradient(0, y - h / 2, 0, y + h / 2);
    grd.addColorStop(0, colors[0]); grd.addColorStop(1, colors[1]);
    g.fillStyle = grd;
    this.rrect(xl, y - h / 2, xr - xl, h, r); g.fill();
    g.shadowBlur = 0;
    g.lineWidth = Math.max(1.5, 2.2 * pr.s); g.strokeStyle = 'rgba(255,255,255,0.9)';
    this.rrect(xl, y - h / 2, xr - xl, h, r); g.stroke();
    // 中央ハイライト
    g.fillStyle = 'rgba(255,255,255,0.75)';
    const iw = (xr - xl) * 0.55;
    this.rrect((xl + xr) / 2 - iw / 2, y - h * 0.12, iw, h * 0.24, h * 0.12); g.fill();
    // フリック矢印
    if (arrow) {
      const bob = ((perf / 380) % 1) * h * 0.5;
      const ax = (xl + xr) / 2, ay = y - h * 0.9 - bob;
      const sz = Math.min(h * 1.25, (xr - xl) * 0.45);
      const ang = arrow === 'left' ? -0.6 : arrow === 'right' ? 0.6 : 0;
      g.translate(ax, ay); g.rotate(ang);
      g.fillStyle = colors[1]; g.strokeStyle = '#fff'; g.lineWidth = Math.max(1.5, 2 * pr.s);
      g.beginPath(); g.moveTo(0, -sz); g.lineTo(sz * 0.85, sz * 0.15); g.lineTo(sz * 0.3, sz * 0.15); g.lineTo(sz * 0.3, sz * 0.55);
      g.lineTo(-sz * 0.3, sz * 0.55); g.lineTo(-sz * 0.3, sz * 0.15); g.lineTo(-sz * 0.85, sz * 0.15); g.closePath();
      g.fill(); g.stroke();
    }
    g.restore();
  }

  rrect(x, y, w, h, r) {
    const g = this.g;
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    g.beginPath();
    g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.arcTo(x + w, y, x + w, y + r, r);
    g.lineTo(x + w, y + h - r); g.arcTo(x + w, y + h, x + w - r, y + h, r);
    g.lineTo(x + r, y + h); g.arcTo(x, y + h, x, y + h - r, r);
    g.lineTo(x, y + r); g.arcTo(x, y, x + r, y, r); g.closePath();
  }

  drawEffects(perf) {
    const g = this.g;
    const life = 380;
    this.fx = this.fx.filter(f => perf - f.at < life);
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const f of this.fx) {
      const k = (perf - f.at) / life;
      const x = this.xAt(f.lp, 1), y = this.yJ;
      const col = f.kind === 'crit' ? [255, 210, 70] : f.kind === 'flick' ? [255, 80, 170] : f.kind === 'hold' ? [90, 255, 160] : [90, 230, 255];
      const a = 1 - k;
      // 縦の光柱
      const bw = this.hwJ / 6 * f.w * (1 - k * 0.3);
      const top = this.proj(0.35 + k * 0.2);
      const lg = g.createLinearGradient(0, y, 0, top.y);
      lg.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${0.45 * a})`);
      lg.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
      g.fillStyle = lg;
      g.fillRect(x - bw / 2, top.y, bw, y - top.y);
      // リング
      const rr = this.noteH * (0.8 + k * 2.4);
      g.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${a})`;
      g.lineWidth = 3 * a + 1;
      g.beginPath(); g.ellipse(x, y, rr * 1.6, rr * 0.55, 0, 0, Math.PI * 2); g.stroke();
      // 火花
      const rnd = U.rng(Math.floor(f.seed * 1e9));
      g.fillStyle = `rgba(255,255,255,${a})`;
      for (let i = 0; i < 7; i++) {
        const ang = -Math.PI * (0.1 + rnd() * 0.8);
        const dist = this.noteH * (1 + k * (3 + rnd() * 4));
        const sx = x + Math.cos(ang) * dist * 1.4, sy = y + Math.sin(ang) * dist;
        g.beginPath(); g.arc(sx, sy, 2.5 * a + 0.5, 0, Math.PI * 2); g.fill();
      }
      if (f.kind === 'flick') {
        g.strokeStyle = `rgba(255,150,210,${a})`; g.lineWidth = 3;
        g.beginPath(); g.moveTo(x, y - this.noteH); g.lineTo(x, y - this.noteH - k * this.H * 0.2); g.stroke();
      }
    }
    g.restore();
  }

  drawCombo(perf) {
    const g = this.g, W = this.W, H = this.H;
    const fs = Math.max(12, Math.min(W, H * 1.6) * 0.022);
    g.textAlign = 'center'; g.textBaseline = 'top';
    if (this.combo >= 2) {
      const bump = Math.max(0, 1 - (perf - this.comboAt) / 120);
      const cy = H * 0.34;
      g.save();
      g.fillStyle = 'rgba(255,255,255,0.75)'; g.font = `800 ${fs * 0.95}px system-ui, sans-serif`;
      g.fillText('COMBO', W / 2, cy - fs * 1.4);
      g.font = `900 ${fs * (3.6 + bump * 0.5)}px system-ui, sans-serif`;
      const grd = g.createLinearGradient(0, cy, 0, cy + fs * 3.6);
      const ap = this.cnt[1] + this.cnt[2] + this.cnt[3] + this.cnt[4] === 0;
      grd.addColorStop(0, ap ? '#fff7c2' : '#ffffff'); grd.addColorStop(1, ap ? '#ffbf1f' : '#9fdcff');
      g.fillStyle = grd; g.globalAlpha = 0.9;
      g.fillText(String(this.combo), W / 2, cy);
      g.restore();
    }
  }

  drawHUD(now, perf) {
    const g = this.g, W = this.W, H = this.H;
    const fs = Math.max(12, Math.min(W, H * 1.6) * 0.022);
    // 進行バー
    const prog = this.lastT > 0 ? U.clamp(now / (this.lastT + 1), 0, 1) : 0;
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(0, 0, W, 4);
    g.fillStyle = this.colors[0]; g.fillRect(0, 0, W * prog, 4);
    // スコア
    const score = Math.round(1000000 * this.sumW / this.total);
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = `700 ${fs * 0.75}px system-ui, sans-serif`;
    g.fillText('SCORE', 16, 14);
    g.fillStyle = '#fff'; g.font = `800 ${fs * 1.6}px system-ui, sans-serif`;
    g.fillText(String(score).padStart(7, '0'), 16, 14 + fs * 0.9);
    // ライフ
    const lw = Math.min(220, W * 0.25), ly = 14 + fs * 2.8;
    g.fillStyle = 'rgba(255,255,255,0.15)'; this.rrect(16, ly, lw, 8, 4); g.fill();
    g.fillStyle = this.life > 300 ? '#5ef0a0' : '#ff5a6e'; this.rrect(16, ly, lw * this.life / 1000, 8, 4); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.7)'; g.font = `600 ${fs * 0.7}px system-ui, sans-serif`;
    g.fillText('LIFE ' + this.life, 16, ly + 12);
    // 曲名 (右上)
    g.textAlign = 'right';
    const rx = W - 76;
    g.fillStyle = 'rgba(255,255,255,0.85)'; g.font = `700 ${fs * 0.85}px system-ui, sans-serif`;
    g.fillText(this.info.title || '', rx, 16, Math.max(80, W * 0.25));
    if (this.info.diff) {
      g.font = `800 ${fs * 0.7}px system-ui, sans-serif`;
      g.fillStyle = { hard: '#ffc233', expert: '#ff4d6d', master: '#c06bff' }[this.info.diff] || '#fff';
      g.fillText(DIFF_LABEL[this.info.diff] + ' ' + (this.info.level || ''), rx, 16 + fs * 1.15);
    }
    if (this.auto) {
      g.fillStyle = 'rgba(255,220,120,0.9)'; g.font = `800 ${fs * 0.75}px system-ui, sans-serif`;
      g.fillText('AUTO PLAY', rx, 16 + fs * 2.2);
    }
    g.textAlign = 'center';
    // 判定表示
    if (this.jDisp) {
      const k = (perf - this.jDisp.at) / 450;
      if (k < 1) {
        const sc = 1 + Math.max(0, 0.25 - k) * 1.2;
        const y = this.yJ - H * 0.2;
        g.save();
        g.globalAlpha = k < 0.75 ? 1 : (1 - k) / 0.25;
        g.translate(W / 2, y); g.scale(sc, sc);
        g.font = `900 ${fs * 1.7}px system-ui, sans-serif`; g.textBaseline = 'middle';
        g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,0.5)';
        g.strokeText(JUDGE_NAMES[this.jDisp.j], 0, 0);
        g.fillStyle = JUDGE_COLORS[this.jDisp.j];
        g.fillText(JUDGE_NAMES[this.jDisp.j], 0, 0);
        if (this.jDisp.fl) {
          g.font = `800 ${fs * 0.8}px system-ui, sans-serif`;
          g.fillStyle = this.jDisp.fl === 'FAST' ? '#6ab8ff' : '#ff7a7a';
          g.fillText(this.jDisp.fl, 0, fs * 1.4);
        }
        g.restore();
      }
    }
    // 開始前
    if (now < 0 || (this.notes.length && now < this.notes[0].t - 1.2 && now < 1)) {
      g.save();
      g.globalAlpha = 0.6 + 0.4 * Math.sin(perf / 200);
      g.fillStyle = '#fff'; g.font = `900 ${fs * 2}px system-ui, sans-serif`; g.textBaseline = 'middle';
      g.fillText('READY', W / 2, H * 0.5);
      if (H > W) {
        g.globalAlpha = 0.8; g.font = `700 ${fs * 0.8}px system-ui, sans-serif`;
        g.fillText('📱 横画面がおすすめ', W / 2, H * 0.5 + fs * 2.2);
      }
      g.restore();
    }
    if (this.finishing) {
      const r = this.result();
      const label = r.ap && !this.auto ? 'ALL PERFECT' : r.fc && !this.auto ? 'FULL COMBO' : 'LIVE CLEAR';
      g.save();
      g.fillStyle = r.ap ? '#ffe066' : r.fc ? '#ff8ae2' : '#9fdcff';
      g.shadowColor = g.fillStyle; g.shadowBlur = 24;
      g.font = `900 ${fs * 3}px system-ui, sans-serif`; g.textBaseline = 'middle';
      g.fillText(label, W / 2, H * 0.5);
      g.restore();
    }
  }
}
