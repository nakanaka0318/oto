'use strict';
/* 共通ユーティリティ */
const U = {
  clamp(v, a, b) { return v < a ? a : v > b ? b : v; },
  lerp(a, b, t) { return a + (b - a) * t; },
  // 決定的な乱数 (mulberry32)
  rng(seed) {
    let s = seed >>> 0;
    const f = () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    f.int = (a, b) => a + Math.floor(f() * (b - a + 1));
    f.pick = arr => arr[Math.floor(f() * arr.length)];
    f.chance = p => f() < p;
    f.sign = () => (f() < 0.5 ? -1 : 1);
    return f;
  },
  hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  },
  uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); },
  fmtTime(t) {
    if (!isFinite(t)) t = 0;
    const neg = t < 0; t = Math.abs(t);
    const m = Math.floor(t / 60), s = t - m * 60;
    return (neg ? '-' : '') + m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  },
  tick() { return new Promise(r => setTimeout(r, 0)); },
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); },
  percentile(arr, q) {
    if (!arr.length) return 0;
    const a = Array.from(arr).sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))];
  },
  download(name, text, type = 'application/json') {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
};

/* 基数2 FFT (実数入力用) */
class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos(-2 * Math.PI * i / n);
      this.sin[i] = Math.sin(-2 * Math.PI * i / n);
    }
    this.re = new Float32Array(n);
    this.im = new Float32Array(n);
  }
  // input: Float32Array(n) → this.re / this.im に結果
  run(input) {
    const n = this.n, re = this.re, im = this.im, rev = this.rev;
    for (let i = 0; i < n; i++) { re[rev[i]] = input[i]; im[i] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * this.cos[k] - im[b] * this.sin[k];
          const ti = re[b] * this.sin[k] + im[b] * this.cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }
}

/* 難易度定義 */
const DIFFS = ['hard', 'expert', 'master'];
const DIFF_LABEL = { hard: 'HARD', expert: 'EXPERT', master: 'MASTER' };

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
