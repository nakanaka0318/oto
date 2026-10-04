'use strict';
/* 画面遷移・選曲・取り込み・設定などアプリ全体の制御 */
const PALETTES = [['#22d3ee', '#a855f7'], ['#f472b6', '#fb923c'], ['#34d399', '#3b82f6'], ['#facc15', '#ef4444'], ['#818cf8', '#ec4899'], ['#2dd4bf', '#eab308']];

const App = {
  engine: new AudioEngine(),
  songs: [], selId: null, diff: 'expert',
  bufCache: new Map(), renderJobs: new Map(), analysisCache: new Map(), peakCache: new Map(), chartCache: {},
  game: null, lastPlay: null,

  async init() {
    Settings.load();
    this.editor = new Editor(this);
    Calibrator.init(this);
    this._bindUI();
    // iOS のピンチズーム等を抑止
    document.addEventListener('gesturestart', e => e.preventDefault());
    document.addEventListener('dblclick', e => { if (!e.target.closest('input, textarea')) e.preventDefault(); });
    try { await this.loadSongs(); } catch (e) { this.toast('保存データを読み込めませんでした: ' + e.message); this.loadBuiltins(); }
    window.addEventListener('resize', () => this.positionYT());
  },

  /* ---------- 共通 UI ---------- */
  show(id) {
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === id));
    this.screen = id;
  },
  toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(this._tt); this._tt = setTimeout(() => t.classList.remove('show'), 2800);
  },
  loading(text, p) {
    $('#loading').hidden = false;
    if (text != null) $('#loading-text').textContent = text;
    $('#loading-bar').style.width = Math.round((p || 0) * 100) + '%';
  },
  hideLoading() { $('#loading').hidden = true; },

  placeYT(mode, slot) {
    const w = $('#yt-wrap');
    w.className = mode === 'game' ? 'yt-game' : mode === 'slot' ? 'yt-slotted' : 'yt-hidden';
    this.ytSlot = mode === 'slot' ? slot : null;
    if (mode !== 'slot') { w.style.left = w.style.top = w.style.width = w.style.height = ''; }
    else {
      const loop = () => { if (this.ytSlot !== slot) return; this.positionYT(); requestAnimationFrame(loop); };
      loop();
    }
  },
  positionYT() {
    if (!this.ytSlot) return;
    const w = $('#yt-wrap'), r = this.ytSlot.getBoundingClientRect();
    if (r.width < 2) { w.style.left = '-10000px'; return; }
    w.style.left = r.left + 'px'; w.style.top = r.top + 'px'; w.style.width = r.width + 'px'; w.style.height = r.height + 'px';
  },

  // スマホ: 全画面 + 横向き固定 (ユーザー操作の直後に呼ぶ必要あり)
  enterFullscreen() {
    if (!Settings.data.fullscreen || !U.isTouch()) return;
    const el = document.documentElement;
    const lock = () => { try { const p = screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'); if (p && p.catch) p.catch(() => {}); } catch (e) { /* 非対応 */ } };
    if (document.fullscreenElement || document.webkitFullscreenElement) { lock(); return; }
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    try {
      const p = req.call(el, { navigationUI: 'hide' });
      if (p && p.then) p.then(lock).catch(() => {}); else lock();
    } catch (e) { /* iPhone Safari などは非対応 */ }
  },

  decode(ab) {
    const ctx = this.engine.ensure();
    return new Promise((res, rej) => {
      const p = ctx.decodeAudioData(ab, res, err => rej(err || new Error('decode error')));
      if (p && p.catch) p.catch(rej);
    });
  },

  /* ---------- 曲データ ---------- */
  loadBuiltins() {
    return AI_SONGS.map(def => ({
      id: def.id, builtin: true, def, title: def.title, sub: def.sub, artist: def.artist, bpm: def.bpm,
      colors: def.colors, desc: def.desc, duration: Composer.schedule(def).duration,
    }));
  },
  async loadSongs() {
    const builtins = this.loadBuiltins();
    let customs = [];
    try { customs = await DB.getAll(); } catch (e) { console.warn(e); }
    customs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    this.songs = builtins.concat(customs);
    if (!this.songs.find(s => s.id === this.selId)) this.selId = this.songs[0].id;
    this.renderSelect();
  },
  song(id) { return this.songs.find(s => s.id === id); },
  chartsOf(song) {
    if (song.builtin) {
      if (!this.chartCache[song.id]) {
        const sc = Composer.schedule(song.def);
        const out = {};
        for (const d of DIFFS) out[d] = ChartGen.generate({ bpm: sc.bpm, offset: sc.offset, duration: sc.duration, events: sc.events }, d, U.hashStr(song.id + ':' + d));
        this.chartCache[song.id] = out;
      }
      return this.chartCache[song.id];
    }
    return song.charts || {};
  },
  sourceType(song) { return song.builtin ? { type: 'builtin', defId: song.id } : song.source; },

  // AI曲のレンダリング (同時に複数回走らないよう Promise を共有)
  renderBuiltin(defId, showProgress) {
    if (this.bufCache.has(defId)) return Promise.resolve(this.bufCache.get(defId));
    let job = this.renderJobs.get(defId);
    if (!job) {
      const def = AI_SONGS.find(d => d.id === defId);
      job = { p: 0 };
      // 裏で描画中はゲームプレイを邪魔しないよう一時停止
      const gate = async () => { while (this.game && !job.show) await new Promise(r => setTimeout(r, 250)); };
      job.promise = Composer.render(def, this.engine, p => {
        job.p = p;
        if (job.show) this.loading(null, p);
      }, gate).then(buf => { this.bufCache.set(defId, buf); this.renderJobs.delete(defId); return buf; });
      this.renderJobs.set(defId, job);
    }
    if (showProgress) { job.show = true; this.loading('AI が曲を演奏しています… (初回のみ)', job.p); }
    return job.promise;
  },

  async getSource(song) {
    const st = this.sourceType(song);
    try {
      if (st.type === 'builtin') {
        const buf = await this.renderBuiltin(st.defId, true);
        this.hideLoading();
        return new BufferSource(this.engine, buf);
      }
      if (st.type === 'file') {
        let buf = this.bufCache.get(song.id);
        if (!buf) {
          this.loading('音声を読み込み中…', 0.3);
          const data = st.data || (st.blob ? await st.blob.arrayBuffer() : null);
          if (!data) throw new Error('音声データがありません');
          buf = await this.decode(data.slice(0));
          this.bufCache.set(song.id, buf);
        }
        this.hideLoading();
        return new BufferSource(this.engine, buf);
      }
      if (st.type === 'youtube') {
        this.loading('YouTube を読み込み中…', 0.5);
        if (!this.ytSlot) this.placeYT('hidden');
        await YTM.load(st.videoId);
        this.hideLoading();
        return new YouTubeSource(this.engine);
      }
      throw new Error('不明な音源');
    } catch (e) {
      this.hideLoading();
      this.toast('読み込みに失敗しました: ' + (e.message || e));
      return null;
    }
  },

  /* ---------- 選曲画面 ---------- */
  jacket(song, big) {
    const c = song.colors || PALETTES[0];
    const st = this.sourceType(song);
    const words = (song.title || '?').split(/\s+/).filter(Boolean);
    const ini = U.esc(words.length > 1 ? words[0][0] + words[1][0] : (song.title || '?').slice(0, 2));
    let style = `background-image: linear-gradient(135deg, ${c[0]}, ${c[1]});`;
    let inner = ini;
    if (st && st.type === 'youtube') { style = `background-image: url(https://i.ytimg.com/vi/${encodeURIComponent(st.videoId)}/hqdefault.jpg);`; inner = ''; }
    return `<div class="jacket${big ? ' big' : ''}" style="${style}">${inner}</div>`;
  },
  tagOf(song) {
    const st = this.sourceType(song);
    return st.type === 'builtin' ? (song.builtin ? 'AI' : 'AI・編集') : st.type === 'youtube' ? 'YouTube' : 'FILE';
  },
  renderSelect() {
    const card = s => {
      const ch = this.chartsOf(s);
      const lv = DIFFS.map(d => ch[d] && ch[d].notes && ch[d].notes.length ? `<span class="lvchip ${d}">${ch[d].level}</span>` : '').join('');
      return `<div class="song-card${s.id === this.selId ? ' sel' : ''}" data-id="${U.esc(s.id)}">
        ${this.jacket(s)}
        <div class="meta"><div class="t">${U.esc(s.title)}<span class="tag">${this.tagOf(s)}</span></div>
        <div class="a">${U.esc([s.artist, s.bpm ? 'BPM ' + s.bpm : ''].filter(Boolean).join(' ・ '))}</div><div class="lv">${lv}</div></div></div>`;
    };
    const b = this.songs.filter(s => s.builtin), c = this.songs.filter(s => !s.builtin);
    $('#song-list').innerHTML = '<div class="list-head">AI SONGS — AI作曲オリジナル</div>' + b.map(card).join('') +
      '<div class="list-head">MY SONGS — 追加した曲</div>' +
      (c.length ? c.map(card).join('') : '<div class="empty">まだありません。「＋ 曲を追加」から音声ファイルや YouTube を追加して譜面を作れます。</div>');
    $$('#song-list .song-card').forEach(el => el.onclick = () => { this.selId = el.dataset.id; this.renderSelect(); });
    this.renderDetail();
  },
  renderDetail() {
    const s = this.song(this.selId);
    if (!s) { $('#song-detail').innerHTML = ''; return; }
    const ch = this.chartsOf(s);
    const st = this.sourceType(s);
    const diffBtns = DIFFS.map(d => {
      const c = ch[d];
      const has = c && c.notes && c.notes.length;
      const best = Best.get(s.id, d);
      const badges = best ? `${best.ap ? '<span class="badge ap">AP</span>' : best.fc ? '<span class="badge fc">FC</span>' : best.clear ? '<span class="badge clr">CLEAR</span>' : ''}${best.score.toLocaleString()}` : '';
      return `<button class="diff-btn ${d}${d === this.diff ? ' sel' : ''}" data-diff="${d}">
        <div class="dn">${DIFF_LABEL[d]}</div><div class="dl">${has ? c.level : '—'}</div>
        <div class="dc">${has ? c.notes.length + ' notes' : '譜面なし'}</div><div class="db">${badges}</div></button>`;
    }).join('');
    const dur = s.duration ? U.fmtTime(s.duration).replace(/\.\d+$/, '') : '';
    const extra = s.builtin
      ? `<button class="btn" id="d-copy">✎ 譜面をコピーして編集</button>`
      : `<button class="btn" id="d-edit">✎ 譜面エディタ</button><button class="btn danger" id="d-del">削除</button>`;
    $('#song-detail').innerHTML = `
      <div class="detail-top">${this.jacket(s, true)}
        <div><h1>${U.esc(s.title)}</h1>
          ${s.sub ? `<div class="sub">${U.esc(s.sub)}</div>` : ''}
          <div class="info">${U.esc([s.artist, 'BPM ' + (s.bpm || '?'), dur, this.tagOf(s)].filter(Boolean).join(' ・ '))}</div>
          ${s.desc ? `<div class="desc">${U.esc(s.desc)}</div>` : ''}
          ${st.type === 'youtube' ? '<div class="desc small">YouTube の動画を背景に再生します (要ネット接続)</div>' : ''}
        </div></div>
      <div class="diff-row">${diffBtns}</div>
      <div class="play-row">
        <button class="btn primary play" id="d-play">▶ PLAY</button>
        <label class="row"><input type="checkbox" id="d-auto" ${Settings.data.auto ? 'checked' : ''}> オート</label>
        ${extra}
      </div>`;
    $$('#song-detail .diff-btn').forEach(el => el.onclick = () => { this.diff = el.dataset.diff; this.renderDetail(); });
    $('#d-play').onclick = () => this.play();
    $('#d-auto').onchange = e => { Settings.data.auto = e.target.checked; Settings.save(); };
    if ($('#d-copy')) $('#d-copy').onclick = () => this.copyBuiltin(s);
    if ($('#d-edit')) $('#d-edit').onclick = () => this.openEditor(s);
    if ($('#d-del')) $('#d-del').onclick = () => this.deleteSong(s);
    // AI曲は選択時に裏でレンダリングしておく
    if (s.builtin && !this.bufCache.has(s.id)) this.renderBuiltin(s.id, false).catch(() => {});
  },

  async play() {
    this.enterFullscreen();
    const s = this.song(this.selId);
    const chart = this.chartsOf(s)[this.diff];
    if (!chart || !chart.notes || !chart.notes.length) { this.toast('この難易度の譜面がありません。エディタで作成してください'); return; }
    this.engine.ensure();
    const source = await this.getSource(s);
    if (!source) return;
    this.startGame({ song: s, diff: this.diff, chart, source, startAt: 0, fromEditor: false });
  },

  startGame(o) {
    this.lastPlay = o;
    const yt = o.source.kind === 'youtube';
    this.show('scr-game');
    this.placeYT(yt ? 'game' : 'hidden');
    const colors = o.song.colors || (o.song.def && o.song.def.colors) || PALETTES[0];
    this.game = new Game({
      canvas: $('#game-canvas'), engine: this.engine, source: o.source, chart: o.chart, startAt: o.startAt || 0,
      info: { title: o.song.title, diff: o.diff, level: o.chart.level, colors },
      onEnd: r => this.onGameEnd(r),
      onPause: () => { $('#modal-pause').hidden = false; },
    });
    this.game.start();
  },

  quitGame() {
    $('#modal-pause').hidden = true;
    if (this.game) { this.game.destroy(); this.game = null; }
    const lp = this.lastPlay;
    lp.source.pause();
    if (lp.fromEditor) { this.show('scr-editor'); this.editor.activate(); }
    else { this.placeYT('hidden'); this.show('scr-select'); this.renderSelect(); }
  },
  retry() {
    this.enterFullscreen();
    $('#modal-pause').hidden = true;
    if (this.game) { this.game.destroy(); this.game = null; }
    this.engine.ensure();
    this.startGame(this.lastPlay);
  },

  onGameEnd(r) {
    this.game = null;
    const lp = this.lastPlay;
    lp.source.pause();
    this.placeYT('hidden');
    let isNew = false;
    if (!r.auto && !r.partial && !lp.fromEditor) {
      isNew = Best.submit(lp.song.id, lp.diff, r).isNew;
    }
    this.renderResult(r, isNew, this.timingCorrection(r));
    this.show('scr-result');
  },
  /* プレイ結果からのオフセット自動補正 */
  timingCorrection(r) {
    const tm = r.timing;
    if (r.auto || !tm || tm.n < 20) return tm && tm.n ? { tm, few: true } : null;
    const ms = Math.round(tm.center * 1000);
    const key = r.sourceKind === 'youtube' ? 'ytOffset' : 'offset';
    if (Math.abs(ms) < 6) return { tm, ms, ok: true, key };
    // 一度に大きく動かしすぎないよう 70% だけ反映
    const delta = U.clamp(Math.round(ms * 0.7), -80, 80);
    const c = { tm, ms, delta, key, prev: Settings.data[key] || 0, applied: false };
    if (Settings.data.autoOffset) this.applyCorrection(c);
    return c;
  },
  applyCorrection(c) {
    Settings.data[c.key] = U.clamp(c.prev + c.delta, -400, 400);
    Settings.save();
    c.applied = true;
  },
  timingHTML(r, c) {
    if (!c) return '';
    const fmt = v => (v > 0 ? '+' : '') + v + 'ms';
    const bins = new Array(25).fill(0);
    (r.diffs || []).forEach(d => { const i = Math.round(d * 1000 / 10) + 12; if (i >= 0 && i < 25) bins[i]++; });
    const mx = Math.max(1, ...bins);
    const hist = `<div class="hist">${bins.map(b => `<i style="height:${Math.round(b / mx * 100)}%"></i>`).join('')}</div>
      <div class="hist-lbl"><span>−120ms 早い</span><span>ジャスト</span><span>遅い +120ms</span></div>`;
    const label = c.key === 'ytOffset' ? 'YouTube 追加補正' : 'オフセット';
    let msg;
    if (c.few) msg = `タイミング計測にはもう少しノーツが必要です (${c.tm.n}/20)`;
    else if (c.ok) msg = `タイミング傾向 <b>${fmt(c.ms)}</b> (ばらつき ±${Math.round(c.tm.spread * 1000)}ms) — ズレはほぼありません 👍`;
    else {
      msg = `タイミング傾向 <b>${fmt(c.ms)} ${c.ms > 0 ? '遅め' : '早め'}</b> (ばらつき ±${Math.round(c.tm.spread * 1000)}ms)<br>`;
      msg += c.applied
        ? `${label}を <b>${fmt(c.delta)}</b> 自動補正しました (${fmt(c.prev)} → <b>${fmt(Settings.data[c.key])}</b>) <button class="btn sm" id="res-undo">元に戻す</button>`
        : `<button class="btn sm primary" id="res-apply">${label}を ${fmt(c.delta)} 補正する</button>`;
    }
    return `<div class="res-timing">${msg}${hist}</div>`;
  },
  renderResult(r, isNew, corr) {
    const lp = this.lastPlay;
    const c = r.cnt;
    const badges = [r.ap ? '<span class="badge ap">ALL PERFECT</span>' : r.fc ? '<span class="badge fc">FULL COMBO</span>' : r.clear ? '<span class="badge clr">LIVE CLEAR</span>' : '<span class="badge clr">FAILED…</span>',
      isNew ? '<span class="badge fc">NEW RECORD</span>' : '', r.auto ? '<span class="badge clr">AUTO</span>' : '', r.partial ? '<span class="badge clr">途中から</span>' : ''].join('');
    $('#result-box').innerHTML = `
      <div class="res-head">${this.jacket(lp.song)}<div><div class="t">${U.esc(lp.song.title)}</div>
        <div class="small">${DIFF_LABEL[lp.diff]} Lv.${lp.chart.level}</div></div></div>
      <div class="res-main"><div class="rank">${r.rank}</div>
        <div class="res-score"><div class="lbl">SCORE</div><div class="v" id="res-score">0</div><div class="res-badges">${badges}</div></div></div>
      <div class="jtable">${JUDGE_NAMES.map((n, i) => `<div class="jcell"><div class="n" style="color:${JUDGE_COLORS[i]}">${n}</div><div class="c">${c[i]}</div></div>`).join('')}</div>
      <div class="res-sub"><span>MAX COMBO <b>${r.maxCombo}</b> / ${r.total}</span><span>FAST <b>${r.fast}</b></span><span>LATE <b>${r.late}</b></span></div>
      ${this.timingHTML(r, corr)}
      <div class="btn-row"><button class="btn primary" id="res-retry">↻ リトライ</button>
        <button class="btn" id="res-back">${lp.fromEditor ? '✎ エディタに戻る' : '♪ 選曲に戻る'}</button></div>`;
    const el = $('#res-score'), t0 = performance.now();
    const anim = () => {
      const k = Math.min(1, (performance.now() - t0) / 900);
      el.textContent = Math.round(r.score * (1 - Math.pow(1 - k, 3))).toLocaleString();
      if (k < 1 && this.screen === 'scr-result') requestAnimationFrame(anim);
    };
    requestAnimationFrame(anim);
    $('#res-retry').onclick = () => { this.engine.ensure(); this.enterFullscreen(); this.startGame(this.lastPlay); };
    if ($('#res-undo')) $('#res-undo').onclick = () => {
      Settings.data[corr.key] = corr.prev; Settings.save(); corr.applied = false;
      $('#res-undo').replaceWith(document.createTextNode('→ 元に戻しました'));
    };
    if ($('#res-apply')) $('#res-apply').onclick = () => {
      this.applyCorrection(corr);
      $('#res-apply').replaceWith(document.createTextNode(`→ 補正しました (現在 ${Settings.data[corr.key]}ms)`));
    };
    $('#res-back').onclick = () => {
      if (lp.fromEditor) { this.show('scr-editor'); this.editor.activate(); }
      else { this.show('scr-select'); this.renderSelect(); }
    };
  },

  /* ---------- エディタ ---------- */
  async openEditor(song) {
    this.engine.ensure();
    const source = await this.getSource(song);
    if (!source) return;
    let peaks = null;
    if (source.kind === 'buffer') {
      peaks = this.peakCache.get(song.id);
      if (!peaks) { peaks = Analyzer.peaks(source.buffer); this.peakCache.set(song.id, peaks); }
      if (!song.duration) song.duration = source.duration;
    }
    this.show('scr-editor');
    this.editor.open({ song, source, diff: this.diff, peaks });
  },
  backFromEditor() {
    this.placeYT('hidden');
    this.show('scr-select');
    this.loadSongs();
  },
  onSongSaved(song) {
    const i = this.songs.findIndex(s => s.id === song.id);
    if (i >= 0) this.songs[i] = song;
  },
  async autoEvents(song, source, bpm, offset, duration) {
    const st = this.sourceType(song);
    if (st.type === 'builtin') return { events: Composer.schedule(AI_SONGS.find(d => d.id === st.defId)).events };
    if (st.type === 'file') {
      let a = this.analysisCache.get(song.id);
      if (!a) {
        this.loading('音声を解析中…', 0);
        try { a = await Analyzer.analyze(source.buffer, p => this.loading(null, p)); } finally { this.hideLoading(); }
        this.analysisCache.set(song.id, a);
      }
      return { events: a.events };
    }
    return { events: ChartGen.patternEvents(bpm, offset, duration, U.hashStr(song.id) + Date.now() % 997) };
  },
  async copyBuiltin(s) {
    const charts = JSON.parse(JSON.stringify(this.chartsOf(s)));
    const sc = Composer.schedule(s.def);
    const song = {
      id: 'c-' + U.uid(), title: s.title + ' (カスタム)', artist: s.artist, bpm: sc.bpm, offset: sc.offset, duration: sc.duration,
      source: { type: 'builtin', defId: s.id }, colors: s.colors, charts, createdAt: Date.now(),
    };
    try { await DB.put(song); } catch (e) { this.toast('保存に失敗: ' + e.message); return; }
    this.selId = song.id;
    await this.loadSongs();
    this.openEditor(this.song(song.id));
  },
  async deleteSong(s) {
    if (!confirm(`「${s.title}」を削除しますか？ (譜面も消えます)`)) return;
    await DB.del(s.id);
    this.bufCache.delete(s.id); this.analysisCache.delete(s.id); this.peakCache.delete(s.id);
    this.selId = null;
    await this.loadSongs();
    this.toast('削除しました');
  },

  /* ---------- 取り込み ---------- */
  openImport() {
    this.show('scr-import');
    if (this.ytSrc && $('#tab-yt').classList.contains('active') && !$('#yt-area').hidden) this.placeYT('slot', $('#yt-slot-import'));
  },
  closeImport() {
    if (this.ytSrc) this.ytSrc.pause();
    this.placeYT('hidden');
    this.show('scr-select');
  },
  setImpFile(f) {
    this.impFile = f;
    $('#drop-text').textContent = f ? `📄 ${f.name} (${(f.size / 1048576).toFixed(1)} MB)` : 'ここにファイルをドロップ / クリックして選択';
    if (f && !$('#imp-title').value) $('#imp-title').value = f.name.replace(/\.[^.]+$/, '');
  },
  async importFile() {
    const f = this.impFile;
    if (!f) { this.toast('ファイルを選択してください'); return; }
    const title = $('#imp-title').value.trim() || f.name.replace(/\.[^.]+$/, '');
    const artist = $('#imp-artist').value.trim();
    const userBpm = parseFloat($('#imp-bpm').value);
    const prog = $('#imp-prog'), bar = prog.querySelector('div'), lbl = prog.querySelector('span');
    const set = (p, t) => { prog.hidden = false; bar.style.width = Math.round(p * 100) + '%'; lbl.textContent = t; };
    $('#imp-go').disabled = true;
    try {
      this.engine.ensure();
      set(0.03, 'ファイルを読み込み中…');
      const data = await f.arrayBuffer();
      set(0.08, '音声をデコード中…');
      let buf;
      try { buf = await this.decode(data.slice(0)); } catch (e) { throw new Error('この形式は再生できません (別の形式でお試しください)'); }
      set(0.12, 'BPM・リズムを解析中…');
      const a = await Analyzer.analyze(buf, p => set(0.12 + p * 0.78, 'BPM・リズムを解析中… ' + Math.round(p * 100) + '%'), userBpm > 0 ? { bpm: userBpm } : {});
      set(0.92, '譜面を生成中…');
      await U.tick();
      const charts = {};
      for (const d of DIFFS) charts[d] = ChartGen.generate({ bpm: a.bpm, offset: a.offset, duration: buf.duration, events: a.events }, d, U.hashStr(title + ':' + d));
      const song = {
        id: 'f-' + U.uid(), title, artist, bpm: a.bpm, offset: +a.offset.toFixed(4), duration: buf.duration,
        source: { type: 'file', data, mime: f.type, name: f.name }, colors: PALETTES[U.hashStr(title) % PALETTES.length],
        charts, createdAt: Date.now(),
      };
      await DB.put(song);
      this.bufCache.set(song.id, buf); this.analysisCache.set(song.id, a);
      set(1, `完了! BPM ${a.bpm} / ${charts.hard.notes.length}・${charts.expert.notes.length}・${charts.master.notes.length} ノーツ`);
      this.toast(`「${title}」を追加しました (BPM ${a.bpm})`);
      this.selId = song.id;
      this.setImpFile(null); $('#imp-title').value = ''; $('#imp-artist').value = ''; $('#imp-bpm').value = '';
      await this.loadSongs();
      if ($('#imp-open-editor').checked) this.openEditor(this.song(song.id));
      else this.show('scr-select');
      setTimeout(() => { prog.hidden = true; }, 500);
    } catch (e) {
      set(0, 'エラー: ' + (e.message || e));
      this.toast('取り込みに失敗しました: ' + (e.message || e));
    } finally {
      $('#imp-go').disabled = false;
    }
  },
  async ytLoad() {
    const id = YTM.parseId($('#yt-url').value);
    if (!id) { this.toast('YouTube の URL を正しく入力してください'); return; }
    this.engine.ensure();
    $('#yt-area').hidden = false;
    this.placeYT('slot', $('#yt-slot-import'));
    this.loading('YouTube を読み込み中…', 0.5);
    try { await YTM.load(id); } catch (e) { this.hideLoading(); this.toast(e.message); return; }
    this.hideLoading();
    this.ytImport = { id };
    this.ytSrc = new YouTubeSource(this.engine);
    const vd = YTM.player.getVideoData ? YTM.player.getVideoData() : {};
    if (vd && vd.title) $('#yt-title').value = vd.title;
    if (vd && vd.author) $('#yt-artist').value = vd.author;
    clearInterval(this._ytTimer);
    this._ytTimer = setInterval(() => {
      if (this.screen !== 'scr-import' || !this.ytSrc) return;
      $('#yt-time').textContent = U.fmtTime(this.ytSrc.time());
    }, 100);
  },
  async ytSave(auto) {
    if (!this.ytImport) return;
    const bpm = parseFloat($('#yt-bpm').value), offset = parseFloat($('#yt-offset').value) || 0;
    if (!(bpm >= 40 && bpm <= 300)) { this.toast('BPM を 40〜300 で入力してください'); return; }
    const title = $('#yt-title').value.trim() || 'YouTube ' + this.ytImport.id;
    this.loading('保存中…', 0.6);
    const duration = await YTM.durationOf();
    if (!duration) { this.hideLoading(); this.toast('動画の長さを取得できませんでした。一度再生してから再度お試しください'); return; }
    const charts = {};
    for (const d of DIFFS) {
      if (auto) charts[d] = ChartGen.generate({ bpm, offset, duration, events: ChartGen.patternEvents(bpm, offset, duration, U.hashStr(this.ytImport.id)) }, d, U.hashStr(this.ytImport.id + d));
      else charts[d] = { bpm, offset, notes: [], level: 1 };
    }
    const song = {
      id: 'y-' + U.uid(), title, artist: $('#yt-artist').value.trim(), bpm, offset, duration,
      source: { type: 'youtube', videoId: this.ytImport.id }, colors: PALETTES[U.hashStr(title) % PALETTES.length], charts, createdAt: Date.now(),
    };
    try { await DB.put(song); } catch (e) { this.hideLoading(); this.toast('保存に失敗: ' + e.message); return; }
    this.hideLoading();
    this.ytSrc.pause();
    this.selId = song.id;
    await this.loadSongs();
    this.toast(`「${title}」を追加しました`);
    if (!auto) this.openEditor(this.song(song.id));
    else { this.placeYT('hidden'); this.show('scr-select'); }
  },

  /* ---------- 設定 ---------- */
  openSettings() {
    const S = Settings.data;
    const bindRange = (id, key, fmt) => {
      const el = $('#' + id), v = $('#' + id + '-v');
      el.value = S[key]; v.textContent = fmt(S[key]);
      el.oninput = () => { S[key] = parseFloat(el.value); v.textContent = fmt(S[key]); Settings.save(); this.engine.applyVolumes(); };
    };
    bindRange('set-speed', 'speed', v => v.toFixed(1));
    bindRange('set-offset', 'offset', v => (v > 0 ? '+' : '') + v);
    bindRange('set-ytoffset', 'ytOffset', v => (v > 0 ? '+' : '') + v);
    bindRange('set-touch', 'touchWide', v => v <= 0.4 ? '狭い' : v <= 1.2 ? '標準' : '広い');
    const nudge = d => { S.offset = U.clamp((S.offset || 0) + d, -400, 400); Settings.save(); this.openSettings(); };
    $('#set-offm').onclick = () => nudge(-5);
    $('#set-offp').onclick = () => nudge(5);
    $('#set-calib').onclick = () => Calibrator.open();
    bindRange('set-music', 'musicVol', v => Math.round(v * 100) + '%');
    bindRange('set-se', 'seVol', v => Math.round(v * 100) + '%');
    bindRange('set-size', 'noteSize', v => v.toFixed(1));
    const chk = (id, key) => { const el = $('#' + id); el.checked = !!S[key]; el.onchange = () => { S[key] = el.checked; Settings.save(); }; };
    chk('set-showkeys', 'showKeys'); chk('set-effects', 'effects'); chk('set-auto', 'auto');
    chk('set-autooffset', 'autoOffset'); chk('set-fullscreen', 'fullscreen'); chk('set-vibrate', 'vibrate'); chk('set-low', 'lowQuality');
    const keysEl = $('#set-keys');
    const renderKeys = () => {
      keysEl.innerHTML = S.keys.map((k, i) => `<button data-i="${i}">${U.esc(k.replace(/^Key|^Digit/, ''))}</button>`).join('');
      $$('#set-keys button').forEach(b => b.onclick = () => {
        b.classList.add('wait'); b.textContent = '?';
        const h = e => {
          e.preventDefault(); window.removeEventListener('keydown', h, true);
          if (e.code !== 'Escape') { S.keys[+b.dataset.i] = e.code; Settings.save(); }
          renderKeys();
        };
        window.addEventListener('keydown', h, true);
      });
    };
    renderKeys();
    $('#modal-settings').hidden = false;
  },

  refreshSettingsUI() { if (!$('#modal-settings').hidden) this.openSettings(); },

  _bindUI() {
    $('#btn-start').onclick = () => {
      this.engine.ensure(); this.enterFullscreen(); this.show('scr-select');
      if (!Settings.data.calibrated) setTimeout(() => this.toast('🎧 初めての方は右上の「音ズレ補正」がおすすめです'), 600);
    };
    $('#btn-calib').onclick = () => Calibrator.open();
    $('#btn-settings').onclick = () => this.openSettings();
    $('#set-close').onclick = () => { $('#modal-settings').hidden = true; if (this.screen === 'scr-select') this.renderDetail(); };
    $('#btn-import').onclick = () => this.openImport();
    $('#imp-back').onclick = () => this.closeImport();
    $('#btn-pause').onclick = () => { if (this.game) this.game.pause(); };
    $('#pz-resume').onclick = () => { $('#modal-pause').hidden = true; this.engine.ensure(); if (this.game) this.game.resume(); };
    $('#pz-retry').onclick = () => this.retry();
    $('#pz-quit').onclick = () => this.quitGame();
    $$('.tabs .tab').forEach(t => t.onclick = () => {
      $$('.tabs .tab').forEach(x => x.classList.toggle('active', x === t));
      $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
      if (t.dataset.tab === 'yt' && this.ytImport) this.placeYT('slot', $('#yt-slot-import'));
      else { if (this.ytSrc) this.ytSrc.pause(); this.placeYT('hidden'); }
    });
    // ファイル
    $('#imp-file').onchange = e => this.setImpFile(e.target.files[0] || null);
    const drop = $('#drop');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) this.setImpFile(e.dataTransfer.files[0]); });
    $('#imp-go').onclick = () => this.importFile();
    // YouTube
    $('#yt-load').onclick = () => this.ytLoad();
    $('#yt-play').onclick = () => { if (this.ytSrc) this.ytSrc.play(this.ytSrc.pos); };
    $('#yt-pause').onclick = () => { if (this.ytSrc) this.ytSrc.pause(); };
    let taps = [];
    $('#yt-tap').onclick = () => {
      const now = performance.now();
      if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
      taps.push(now); if (taps.length > 16) taps.shift();
      if (taps.length >= 4) {
        const bpm = Math.round(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)) * 10) / 10;
        $('#yt-bpm').value = bpm; $('#yt-tapinfo').textContent = `${bpm} BPM (${taps.length}回)`;
      } else $('#yt-tapinfo').textContent = `あと${4 - taps.length}回…`;
    };
    $('#yt-setoff').onclick = () => {
      if (!this.ytSrc) return;
      const t = Math.max(0, this.ytSrc.time() - Settings.offsetFor('youtube'));
      $('#yt-offset').value = t.toFixed(3);
    };
    $('#yt-save-auto').onclick = () => this.ytSave(true);
    $('#yt-save-edit').onclick = () => this.ytSave(false);
  },
};

window.addEventListener('DOMContentLoaded', () => App.init());
