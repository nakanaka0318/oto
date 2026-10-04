'use strict';
/*
 * 取り込んだ音声の解析
 *  - STFT → 帯域別スペクトルフラックス → オンセット検出
 *  - オンセット関数の自己相関で BPM 推定、グリッド位相探索で1拍目オフセット推定
 *  - 各オンセットの強さ・音色の明るさ(→レーン位置)・持続時間(→ロングノーツ)を算出
 */
const Analyzer = (() => {
  const ONSET_LAG = -0.006; // フレーム中心時刻と実際のアタックのずれ補正
  async function analyze(buffer, onProgress = () => {}, opts = {}) {
    const sr0 = buffer.sampleRate;
    const ds = Math.max(1, Math.round(sr0 / 22050));
    const sr = sr0 / ds;
    const len = Math.floor(buffer.length / ds);
    const mono = new Float32Array(len);
    const chs = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c));
    const norm = 1 / (ds * chs.length);
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (const ch of chs) for (let k = 0; k < ds; k++) s += ch[i * ds + k] || 0;
      mono[i] = s * norm;
    }
    await U.tick();

    const N = 1024, hop = 256, nb = N / 2;
    const frames = Math.max(1, Math.floor((len - N) / hop) + 1);
    const fps = sr / hop;
    const fft = new FFT(N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    const binHz = sr / N;
    const bLow = Math.max(2, Math.round(160 / binHz)), bMid = Math.round(2500 / binHz), bHigh = Math.min(nb, Math.round(9000 / binHz));
    const prev = new Float32Array(nb), cur = new Float32Array(nb), frame = new Float32Array(N);
    const fL = new Float32Array(frames), fM = new Float32Array(frames), fH = new Float32Array(frames);
    const eMid = new Float32Array(frames), cent = new Float32Array(frames), rms = new Float32Array(frames);

    for (let f = 0; f < frames; f++) {
      const o = f * hop;
      let e = 0;
      for (let i = 0; i < N; i++) { const v = mono[o + i]; frame[i] = v * win[i]; e += v * v; }
      rms[f] = Math.sqrt(e / N);
      fft.run(frame);
      let sl = 0, sm = 0, sh = 0, em = 0, cw = 0, cs = 0;
      for (let b = 1; b < bHigh; b++) {
        const mag = Math.hypot(fft.re[b], fft.im[b]);
        const lm = Math.log(1 + 100 * mag);
        cur[b] = lm;
        const d = lm - prev[b];
        if (d > 0) { if (b < bLow) sl += d; else if (b < bMid) sm += d; else sh += d; }
        if (b >= bLow && b < bMid) em += mag * mag;
        if (b >= bLow) { cw += mag * b; cs += mag; }
      }
      fL[f] = sl; fM[f] = sm; fH[f] = sh; eMid[f] = em; cent[f] = cs > 0 ? cw / cs : 0;
      prev.set(cur);
      if ((f & 511) === 0) { onProgress(0.05 + 0.6 * f / frames); await U.tick(); }
    }

    const pL = U.percentile(fL, 0.95) || 1, pM = U.percentile(fM, 0.95) || 1, pH = U.percentile(fH, 0.95) || 1;
    const odf = new Float32Array(frames);
    for (let f = 0; f < frames; f++) odf[f] = fL[f] / pL * 1.0 + fM[f] / pM * 0.9 + fH[f] / pH * 0.6;
    // 局所平均を引いた ODF (テンポ推定用)
    const odfN = new Float32Array(frames);
    const W = Math.round(fps * 0.4);
    let acc = 0;
    const csum = new Float64Array(frames + 1);
    for (let f = 0; f < frames; f++) { acc += odf[f]; csum[f + 1] = acc; }
    for (let f = 0; f < frames; f++) {
      const a = Math.max(0, f - W), b = Math.min(frames, f + W + 1);
      odfN[f] = Math.max(0, odf[f] - (csum[b] - csum[a]) / (b - a));
    }
    onProgress(0.7); await U.tick();

    // ---- テンポ推定 ----
    const acAt = lag => {
      const l0 = Math.floor(lag), fr = lag - l0;
      let s = 0;
      const lim = frames - l0 - 1;
      for (let i = 0; i < lim; i++) s += odfN[i] * (odfN[i + l0] * (1 - fr) + odfN[i + l0 + 1] * fr);
      return s / Math.max(1, lim);
    };
    let best = { bpm: 120, score: -1 };
    const scores = [];
    for (let bpm = 70; bpm <= 200; bpm += 0.5) {
      const lag = fps * 60 / bpm;
      const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 135) / 0.75, 2));
      const sc = (acAt(lag) + 0.5 * acAt(lag * 2) + 0.25 * acAt(lag / 2)) * (0.6 + 0.4 * w);
      scores.push(sc);
      if (sc > best.score) best = { bpm, score: sc };
    }
    // 微調整
    for (let bpm = best.bpm - 0.5; bpm <= best.bpm + 0.5; bpm += 0.05) {
      const lag = fps * 60 / bpm;
      const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 135) / 0.75, 2));
      const sc = (acAt(lag) + 0.5 * acAt(lag * 2) + 0.25 * acAt(lag / 2)) * (0.6 + 0.4 * w);
      if (sc > best.score) best = { bpm, score: sc };
    }
    // コムフィルタで精密化 (全体を通してグリッドが合う BPM と位相)
    const sm = new Float32Array(frames);
    for (let f = 1; f < frames - 1; f++) sm[f] = odf[f - 1] * 0.25 + odf[f] * 0.5 + odf[f + 1] * 0.25;
    const comb = (b) => {
      const period = fps * 60 / b;
      let bs = -1, bp = 0;
      for (let ph = 0; ph < period; ph += 0.5) {
        let s = 0, c = 0;
        for (let x = ph; x < frames - 1; x += period) { const i = x | 0, fr = x - i; s += sm[i] * (1 - fr) + sm[i + 1] * fr; c++; }
        s /= c || 1;
        if (s > bs) { bs = s; bp = ph; }
      }
      return { s: bs, ph: bp };
    };
    const refine = (b0, span) => {
      let r = { bpm: b0, ...comb(b0) };
      for (let b = b0 - span; b <= b0 + span; b += 0.05) {
        if (b < 60 || b > 220) continue;
        const c = comb(b);
        if (c.s > r.s) r = { bpm: b, ...c };
      }
      return r;
    };
    let R = opts.bpm ? { bpm: opts.bpm } : refine(best.bpm, 1.5);
    if (opts.bpm) { /* 指定BPMを使用 */ } else if (R.bpm < 100) {
      const R2 = refine(R.bpm * 2, 1.0);
      if (R2.s >= R.s * 0.72) R = R2;
    } else if (R.bpm > 200) {
      R = refine(R.bpm / 2, 0.5);
    }
    let bpm = R.bpm;
    if (opts.bpm) { /* そのまま */ } else if (Math.abs(bpm - Math.round(bpm)) < 0.25) bpm = Math.round(bpm);
    else bpm = Math.round(bpm * 10) / 10;
    const meanSc = scores.reduce((a, b) => a + b, 0) / scores.length;
    const confidence = U.clamp((best.score / (meanSc || 1) - 1) / 1.5, 0, 1);
    onProgress(0.8); await U.tick();

    // ---- 位相 (オフセット) ----
    const period = fps * 60 / bpm;
    const frameTime = f => (f * hop + N / 2) / sr;
    let bestPh = 0, bestPhS = -1;
    for (let ph = 0; ph < period; ph += 0.25) {
      let s = 0;
      for (let x = ph; x < frames - 1; x += period) {
        const i = Math.floor(x), fr = x - i;
        s += sm[i] * (1 - fr) + sm[i + 1] * fr;
      }
      if (s > bestPhS) { bestPhS = s; bestPh = ph; }
    }
    const beat = 60 / bpm;
    let offset = frameTime(bestPh) - ONSET_LAG;
    offset = ((offset % beat) + beat) % beat;

    // ---- オンセット検出 ----
    const onsets = [];
    const W2 = Math.round(fps * 0.15);
    const pMax = U.percentile(odf, 0.99) || 1;
    let lastF = -1e9;
    for (let f = 2; f < frames - 2; f++) {
      const v = odf[f];
      if (!(v >= odf[f - 1] && v >= odf[f - 2] && v > odf[f + 1] && v >= odf[f + 2])) continue;
      const a = Math.max(0, f - W2), b = Math.min(frames, f + W2 + 1);
      const mean = (csum[b] - csum[a]) / (b - a);
      if (v < mean * 1.25 + pMax * 0.06) continue;
      if (f - lastF < fps * 0.05) continue;
      lastF = f;
      onsets.push(f);
    }
    onProgress(0.88); await U.tick();

    // 明るさ(重心)の分布
    const cs = onsets.map(f => cent[f]);
    const c05 = U.percentile(cs, 0.05), c95 = U.percentile(cs, 0.95);
    const events = [];
    const q16 = beat / 4;
    for (const f of onsets) {
      const t = frameTime(f) - ONSET_LAG;
      let s = U.clamp(odf[f] / pMax, 0, 1) * 0.75;
      const pos = (t - offset) / q16;
      const q = Math.round(pos);
      if (Math.abs(pos - q) > 0.45) s *= 0.7;
      const qm = ((q % 4) + 4) % 4;
      s += qm === 0 ? 0.15 : qm === 2 ? 0.06 : 0;
      // 持続 (中域エネルギーが続く長さ)
      const e0 = Math.max(eMid[f], eMid[f + 1] || 0, eMid[f + 2] || 0);
      let k = f + 2;
      const lim = Math.min(frames, f + Math.round(fps * 4));
      while (k < lim && eMid[k] > e0 * 0.35) {
        if (fL[k] / pL + fM[k] / pM > 1.6 && k > f + fps * 0.12) break; // 次の強いアタック
        k++;
      }
      const d = (k - f) / fps;
      const p = c95 > c05 ? U.clamp((cent[f] - c05) / (c95 - c05), 0, 1) : 0.5;
      const low = fL[f] / pL, hi = fH[f] / pH;
      events.push({ t, s: U.clamp(s, 0, 0.97), p, d: d >= 0.3 ? d : 0, kind: low > hi * 1.5 ? 'kick' : 'mel' });
    }

    // 小節ごとのエネルギー変化 → アクセント
    const barF = period * 4;
    const barE = [];
    const startF = (offset * sr - N / 2) / hop;
    for (let x = startF; x < frames; x += barF) {
      const a = Math.max(0, Math.floor(x)), b = Math.min(frames, Math.floor(x + barF));
      let s = 0; for (let i = a; i < b; i++) s += rms[i];
      barE.push(b > a ? s / (b - a) : 0);
    }
    const medE = U.percentile(barE, 0.5);
    for (let i = 1; i < barE.length; i++) {
      const prevMean = barE.slice(Math.max(0, i - 4), i).reduce((a, b) => a + b, 0) / Math.min(4, i);
      if (barE[i] > prevMean * 1.3 && barE[i] > medE * 0.9) {
        events.push({ t: offset + i * beat * 4, s: 1, kind: 'crash', accent: true });
      }
    }
    onProgress(1);
    return { bpm, offset, confidence, duration: buffer.duration, events };
  }

  // エディタ用の波形ピーク
  function peaks(buffer, perSec = 200) {
    const sr = buffer.sampleRate, n = Math.ceil(buffer.duration * perSec), step = sr / perSec;
    const out = new Float32Array(n);
    const ch0 = buffer.getChannelData(0), ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
    for (let i = 0; i < n; i++) {
      let m = 0;
      const a = Math.floor(i * step), b = Math.min(ch0.length, Math.floor((i + 1) * step));
      for (let j = a; j < b; j += 2) { const v = Math.abs(ch0[j]) + Math.abs(ch1[j]); if (v > m) m = v; }
      out[i] = m * 0.5;
    }
    return out;
  }

  return { analyze, peaks };
})();
