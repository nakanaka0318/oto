'use strict';
/* オーディオエンジン: AudioContext 管理・効果音・再生ソース */
class AudioEngine {
  constructor() { this.ctx = null; this._off = null; this.se = {}; }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.connect(this.master);
      this.seGain = this.ctx.createGain();
      this.seGain.connect(this.master);
      this._makeSE();
      this.applyVolumes();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    // iPhone のマナーモードでも音が鳴るように
    try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch (e) { /* ignore */ }
    return this.ctx;
  }

  applyVolumes() {
    if (!this.ctx) return;
    const s = Settings.data;
    this.musicGain.gain.value = s.musicVol;
    this.seGain.gain.value = s.seVol;
  }

  // performance.now() の時刻 → 実際にスピーカーから出ている AudioContext 時刻
  ctxTimeAtPerf(perf) {
    const ctx = this.ctx;
    const pnow = performance.now();
    let off;
    const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime > 0 && ts.contextTime > 0) off = ts.contextTime - ts.performanceTime / 1000;
    else off = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0) - pnow / 1000;
    if (this._off == null || Math.abs(off - this._off) > 0.04) this._off = off;
    else this._off += (off - this._off) * 0.03;
    return perf / 1000 + this._off;
  }

  _buf(sec, fn) {
    const sr = this.ctx.sampleRate, n = Math.floor(sec * sr);
    const b = this.ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
    let seed = 1234567;
    const noise = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) * 2 - 1; };
    for (let i = 0; i < n; i++) d[i] = fn(i / sr, noise);
    return b;
  }

  _makeSE() {
    const TAU = Math.PI * 2;
    this.se.perfect = this._buf(0.14, (t, nz) =>
      (Math.sin(TAU * 1567 * t) * 0.45 + Math.sin(TAU * 2349 * t) * 0.3) * Math.exp(-t * 38) + nz() * Math.exp(-t * 260) * 0.35);
    this.se.great = this._buf(0.12, (t, nz) =>
      (Math.sin(TAU * 1175 * t) * 0.45 + Math.sin(TAU * 1760 * t) * 0.2) * Math.exp(-t * 40) + nz() * Math.exp(-t * 260) * 0.3);
    this.se.good = this._buf(0.1, (t, nz) => Math.sin(TAU * 880 * t) * Math.exp(-t * 45) * 0.4 + nz() * Math.exp(-t * 300) * 0.2);
    let lp = 0;
    this.se.flick = this._buf(0.18, (t, nz) => {
      lp += (nz() - lp) * (0.08 + t * 3);
      return lp * Math.sin(Math.PI * Math.min(1, t / 0.18)) * 1.6 + Math.sin(TAU * (1400 + t * 6000) * t) * Math.exp(-t * 30) * 0.25;
    });
    this.se.crit = this._buf(0.3, (t, nz) =>
      (Math.sin(TAU * 2093 * t) * 0.35 + Math.sin(TAU * 3136 * t) * 0.25 + Math.sin(TAU * 1568 * t) * 0.3) * Math.exp(-t * 14) + nz() * Math.exp(-t * 250) * 0.35);
    this.se.tick = this._buf(0.05, (t) => Math.sin(TAU * 2600 * t) * Math.exp(-t * 90) * 0.35);
    // メトロノーム (立ち上がりが鋭い = 補正精度が上がる)
    this.se.click = this._buf(0.06, (t, nz) => (Math.sin(TAU * 1200 * t) * 0.7 + nz() * 0.3) * Math.exp(-t * 80) * 0.9);
    this.se.clickHi = this._buf(0.06, (t, nz) => (Math.sin(TAU * 1800 * t) * 0.7 + nz() * 0.3) * Math.exp(-t * 80) * 1.0);
  }

  playSE(name, vol = 1, when = 0) {
    if (!this.ctx || !this.se[name]) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.se[name];
    if (vol !== 1) {
      const g = this.ctx.createGain(); g.gain.value = vol;
      src.connect(g); g.connect(this.seGain);
    } else src.connect(this.seGain);
    src.start(when || 0);
  }
}

/* AudioBuffer 再生ソース。time() は「今聞こえている曲の位置(秒)」 */
class BufferSource {
  constructor(engine, buffer) {
    this.engine = engine; this.buffer = buffer; this.kind = 'buffer';
    this.node = null; this.playing = false; this.pos = 0; this.rate = 1; this.ended = false;
  }
  get duration() { return this.buffer.duration; }
  play(from = this.pos) {
    const ctx = this.engine.ensure();
    this._stopNode();
    this.ended = false;
    const startCtx = ctx.currentTime + 0.05;
    this.anchorCtx = startCtx; this.anchorSong = from;
    const node = ctx.createBufferSource();
    node.buffer = this.buffer;
    node.playbackRate.value = this.rate;
    node.connect(this.engine.musicGain);
    if (from >= 0) { if (from < this.buffer.duration) node.start(startCtx, from); }
    else node.start(startCtx + (-from) / this.rate, 0);
    node.onended = () => { if (this.node === node) { this.node = null; this.playing = false; this.ended = true; this.pos = this.duration; } };
    this.node = node; this.playing = true;
  }
  pause() { if (!this.playing) return; this.pos = this.time(); this._stopNode(); this.playing = false; }
  stop() { this._stopNode(); this.playing = false; this.pos = 0; }
  seek(t) { this.pos = t; if (this.playing) this.play(t); }
  setRate(r) { const t = this.time(); this.rate = r; if (this.playing) this.play(t); else this.pos = t; }
  _stopNode() {
    if (!this.node) return;
    const n = this.node; this.node = null;
    n.onended = null;
    try { n.stop(); } catch (e) { /* ignore */ }
    n.disconnect();
  }
  timeAt(perf) {
    if (!this.playing) return this.pos;
    const c = this.engine.ctxTimeAtPerf(perf);
    return this.anchorSong + (c - this.anchorCtx) * this.rate;
  }
  time() { return this.timeAt(performance.now()); }
}

/* YouTube IFrame Player 管理 */
const YTM = {
  apiPromise: null, player: null, ready: false, videoId: null, state: -1, error: null,
  listeners: new Set(),
  parseId(url) {
    url = (url || '').trim();
    if (/^[\w-]{11}$/.test(url)) return url;
    const m = url.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/|\/v\/)([\w-]{11})/);
    return m ? m[1] : null;
  },
  loadAPI() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (!this.apiPromise) {
      this.apiPromise = new Promise((res, rej) => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { if (prev) prev(); res(); };
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        s.onerror = () => { this.apiPromise = null; rej(new Error('YouTube API を読み込めませんでした (ネット接続を確認)')); };
        document.head.appendChild(s);
      });
    }
    return this.apiPromise;
  },
  errorText(code) {
    return ({ 2: '動画IDが不正です', 5: 'HTML5プレイヤーのエラー', 100: '動画が見つかりません (削除/非公開)',
      101: 'この動画は埋め込み再生が許可されていません', 150: 'この動画は埋め込み再生が許可されていません',
      153: '埋め込みに必要な情報が不足しています (http(s):// でページを開いてください)' })[code] || ('YouTubeエラー ' + code);
  },
  waitState(states, timeout = 8000) {
    return new Promise((res, rej) => {
      if (states.includes(this.state)) { res(this.state); return; }
      const f = (s, err) => {
        if (s === 'error') { this.listeners.delete(f); clearTimeout(tm); rej(new Error(this.errorText(err))); return; }
        if (states.includes(s)) { this.listeners.delete(f); clearTimeout(tm); res(s); }
      };
      const tm = setTimeout(() => { this.listeners.delete(f); rej(new Error('YouTube の応答がタイムアウトしました')); }, timeout);
      this.listeners.add(f);
    });
  },
  async load(videoId) {
    await this.loadAPI();
    this.error = null;
    if (this.player && this.ready) {
      if (this.videoId !== videoId) {
        this.videoId = videoId;
        this.state = -1;
        this.player.cueVideoById(videoId);
        await this.waitState([5, 1, 2], 10000);
      }
      return this.player;
    }
    this.videoId = videoId;
    await new Promise((res, rej) => {
      const tm = setTimeout(() => rej(new Error('YouTube プレイヤーの初期化がタイムアウトしました')), 15000);
      const vars = { controls: 0, disablekb: 1, playsinline: 1, rel: 0, modestbranding: 1, iv_load_policy: 3, fs: 0 };
      if (location.protocol.startsWith('http')) vars.origin = location.origin;
      this.player = new YT.Player('yt-player', {
        width: '100%', height: '100%', videoId, playerVars: vars,
        events: {
          onReady: () => { this.ready = true; clearTimeout(tm); res(); },
          onStateChange: e => { this.state = e.data; this.listeners.forEach(f => f(e.data)); },
          onError: e => { this.error = e.data; this.listeners.forEach(f => f('error', e.data)); },
        },
      });
    });
    return this.player;
  },
  async durationOf() {
    for (let i = 0; i < 40; i++) {
      const d = this.player.getDuration();
      if (d > 0) return d;
      await new Promise(r => setTimeout(r, 150));
    }
    return 0;
  },
};

class YouTubeSource {
  constructor(engine) {
    this.engine = engine; this.p = YTM.player; this.kind = 'youtube';
    this.playing = false; this.pos = 0; this.rate = 1; this.ended = false;
    this._aT = 0; this._aP = 0; this._last = null;
  }
  get duration() { return this.p.getDuration() || 0; }
  play(from = this.pos) {
    from = Math.max(0, from);
    this.ended = false;
    this.p.seekTo(from, true);
    this.p.playVideo();
    this.playing = true;
    this._aT = from; this._aP = performance.now(); this._last = null;
  }
  pause() { if (!this.playing) return; this.pos = this.time(); this.p.pauseVideo(); this.playing = false; }
  stop() { try { this.p.pauseVideo(); } catch (e) { /* ignore */ } this.playing = false; this.pos = 0; }
  seek(t) { this.pos = Math.max(0, t); if (this.playing) this.play(this.pos); else this.p.seekTo(this.pos, true); }
  setRate(r) { const t = this.time(); this.rate = r; this.p.setPlaybackRate(r); if (!this.playing) this.pos = t; }
  _update() {
    const now = performance.now();
    const st = this.p.getPlayerState();
    const raw = this.p.getCurrentTime() || 0;
    if (st === 0) { this.playing = false; this.ended = true; this.pos = raw; return; }
    if (st !== 1) { this._aT = raw; this._aP = now; this._last = null; return; }
    if (raw !== this._last) {
      this._last = raw;
      const est = this._aT + (now - this._aP) / 1000 * this.rate;
      const nt = Math.abs(est - raw) > 0.15 ? raw : est + (raw - est) * 0.12;
      this._aT = nt; this._aP = now;
    }
  }
  timeAt(perf) {
    if (!this.playing) return this.pos;
    this._update();
    if (!this.playing) return this.pos;
    const st = this.p.getPlayerState();
    if (st !== 1) return this._aT;
    return this._aT + (perf - this._aP) / 1000 * this.rate;
  }
  time() { return this.timeAt(performance.now()); }
}
