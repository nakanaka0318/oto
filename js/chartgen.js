'use strict';
/*
 * 譜面自動生成
 * 入力イベント列 {t, s(強さ0..1), p(音高0..1|null), d(持続秒), accent, kind}
 * → 難易度ごとにノーツを選別し、レーン配置・ロング/スライド/フリック/クリティカル/同時押しを決定
 * ノーツ形式: {t, lane(0..11), w(幅), type:'tap'|'flick'|'hold', crit, dir:'up'|'left'|'right',
 *              end, endLane, endFlick}
 */
const ChartGen = (() => {
  const CFG = {
    hard: { minGap: 0.5, maxNps: 3.3, allow16: 0.9, wMin: 3, wMax: 4, holdMin: 1.0, holdProb: 0.55, slideProb: 0.0,
      flickProb: 0.05, accentFlick: 0.4, doubleProb: 0.0, wideProb: 0.6, endFlickProb: 0, maxHold: 4 },
    expert: { minGap: 0.25, maxNps: 5.6, allow16: 0.58, wMin: 2, wMax: 4, holdMin: 1.0, holdProb: 0.65, slideProb: 0.35,
      flickProb: 0.1, accentFlick: 0.6, doubleProb: 0.2, wideProb: 0.35, endFlickProb: 0.2, maxHold: 4 },
    master: { minGap: 0.25, maxNps: 8.2, allow16: 0, wMin: 2, wMax: 3, holdMin: 0.75, holdProb: 0.7, slideProb: 0.6,
      flickProb: 0.14, accentFlick: 0.75, doubleProb: 0.3, wideProb: 0.25, endFlickProb: 0.35, maxHold: 4 },
  };

  function generate(input, diff, seed) {
    const cfg = CFG[diff];
    const rng = U.rng(seed >>> 0);
    const bpm = input.bpm, beat = 60 / bpm, off = input.offset || 0, q16 = beat / 4;
    const startMin = Math.max(1.0, input.startMin || 0), endMax = (input.duration || 1e9) - 0.3;

    // 1) 16分グリッドへスナップ & 同時刻マージ
    const map = new Map();
    for (const e of input.events) {
      const q = Math.round((e.t - off) / q16);
      const t = off + q * q16;
      if (t < startMin || t > endMax) continue;
      const cur = map.get(q);
      if (!cur) map.set(q, { t, q, s: e.s, p: e.p ?? null, d: e.d || 0, accent: !!e.accent, final: !!e.final, kinds: [e.kind] });
      else {
        cur.s = Math.max(cur.s, e.s) + 0.04;
        if (e.p != null && (cur.p == null || e.kind === 'mel')) cur.p = e.p;
        cur.d = Math.max(cur.d, e.d || 0);
        cur.accent = cur.accent || !!e.accent; cur.final = cur.final || !!e.final;
        cur.kinds.push(e.kind);
      }
    }

    // 2) 強さ順に選別 (最小間隔 / 密度上限)
    const cands = [...map.values()].filter(c => {
      const on8 = ((c.q % 2) + 2) % 2 === 0;
      return on8 || c.s >= cfg.allow16;
    }).sort((a, b) => b.s - a.s || a.t - b.t);
    const acc = [];
    const minGap = beat * cfg.minGap - 1e-4;
    for (const c of cands) {
      let lo = 0, hi = acc.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (acc[m].t < c.t) lo = m + 1; else hi = m; }
      if ((lo > 0 && c.t - acc[lo - 1].t < minGap) || (lo < acc.length && acc[lo].t - c.t < minGap)) continue;
      let cnt = 0;
      for (let i = lo - 1; i >= 0 && c.t - acc[i].t < 1; i--) cnt++;
      for (let i = lo; i < acc.length && acc[i].t - c.t < 1; i++) cnt++;
      if (cnt >= cfg.maxNps * 2) continue;
      acc.splice(lo, 0, c);
    }

    // 3) 配置
    const notes = [];
    let prev = null, hold = null;
    const snapT = t => off + Math.round((t - off) / q16) * q16;
    for (let i = 0; i < acc.length; i++) {
      const e = acc[i], t = e.t;
      if (hold && t > hold.end + beat * 0.24) hold = null;
      const inHold = !!hold;
      if (inHold && diff === 'hard' && ((e.q % 4) + 4) % 4 !== 0) continue;
      const gap = prev ? (t - prev.t) / beat : 99;
      let w = rng.int(cfg.wMin, cfg.wMax);
      if (gap <= 0.3 && w > 3) w = 3;
      let center;
      if (inHold) {
        const side = -hold.side;
        const lo = side < 0 ? w / 2 : 6 + w / 2, hi = side < 0 ? 6 - w / 2 : 12 - w / 2;
        const base = (lo + hi) / 2;
        center = base + (e.p != null ? (e.p - 0.5) * 4 : rng.int(-2, 2));
        if (prev && prev.side === side && gap <= 0.3 && Math.abs(center - prev.center) < 1) center += rng.sign() * 1.5;
        center = U.clamp(center, lo, hi);
      } else if (!prev) {
        center = 6 + rng.int(-2, 2);
      } else if (gap <= 0.3) {
        // 速い連打は左右交互 / 音程に沿った階段
        let dir = prev.center >= 6 ? -1 : 1;
        if (e.p != null && prev.p != null && Math.abs(e.p - prev.p) > 0.01) dir = Math.sign(e.p - prev.p);
        const dist = (prev.w + w) / 2 + rng.int(0, 1);
        center = prev.center + dir * dist;
        if (center - w / 2 < 0 || center + w / 2 > 12) center = prev.center - dir * dist;
      } else {
        if (e.p != null && prev.p != null) {
          const dp = e.p - prev.p;
          center = prev.center + U.clamp(dp * 22, -5, 5);
          if (Math.abs(dp) < 0.01 && gap >= 1 && rng() < 0.5) center += rng.sign() * 2;
        } else {
          center = prev.center + rng.sign() * rng.int(2, 4);
        }
        // 端に寄りすぎたら中央へ戻す
        if (center < 2 && rng() < 0.5) center += 3;
        if (center > 10 && rng() < 0.5) center -= 3;
      }
      let lane = U.clamp(Math.round(center - w / 2), 0, 12 - w);

      const n = { t, lane, w, type: 'tap', crit: false };
      // ロング
      if (!inHold && e.d >= cfg.holdMin * beat && rng() < cfg.holdProb) {
        const endT = snapT(t + Math.min(e.d, cfg.maxHold * beat));
        if (endT - t >= beat * 0.5) {
          const side = lane + w / 2 < 6 ? -1 : lane + w / 2 > 6 ? 1 : rng.sign();
          if (side < 0 && lane + w > 7) lane = 7 - w;
          if (side > 0 && lane < 5) lane = 5;
          n.lane = lane; n.type = 'hold'; n.end = endT; n.endLane = lane;
          if (rng() < cfg.slideProb) {
            const lo = side < 0 ? 0 : 5, hi = side < 0 ? 7 - w : 12 - w;
            n.endLane = U.clamp(lane + rng.sign() * rng.int(2, 4), lo, hi);
            if (n.endLane === lane) n.endLane = U.clamp(lane - 2 * side, lo, hi);
          }
          if (rng() < cfg.endFlickProb) n.endFlick = true;
          hold = { end: endT, side };
        }
      }
      const isCrash = e.kinds.includes('crash');
      // フリック
      if (n.type === 'tap') {
        const fast = gap <= 0.3 && diff !== 'master';
        if (!fast && ((e.accent && rng() < cfg.accentFlick) || rng() < cfg.flickProb)) n.type = 'flick';
      }
      if (isCrash && e.s >= 0.99) n.crit = true;
      if (e.final) {
        n.type = 'flick'; n.crit = true; n.w = 6; n.lane = 3; delete n.end; delete n.endLane; delete n.endFlick;
      }
      if (n.type === 'flick') {
        const c = n.lane + n.w / 2;
        n.dir = rng() < 0.5 || !prev ? 'up' : c > prev.center + 0.5 ? 'right' : c < prev.center - 0.5 ? 'left' : 'up';
      }
      // アクセント: ワイドノーツ or 同時押し
      let dbl = null;
      if (!inHold && n.type !== 'hold' && !e.final && (isCrash || e.accent)) {
        if (isCrash && (diff === 'hard' || rng() < cfg.wideProb)) {
          n.w = rng.int(5, 7); n.lane = Math.round(6 - n.w / 2);
        } else if (cfg.doubleProb > 0 && (isCrash || rng() < cfg.doubleProb * 2)) {
          dbl = true;
        }
      } else if (!inHold && n.type !== 'hold' && e.s >= 0.95 && rng() < cfg.doubleProb * 0.6) dbl = true;
      notes.push(n);
      if (dbl) {
        if (n.lane + n.w > 6 && n.lane < 6) { n.lane = n.lane + n.w / 2 < 6 ? 6 - n.w : 6; }
        const m = { ...n, lane: 12 - n.lane - n.w };
        if (m.dir === 'left') m.dir = 'right'; else if (m.dir === 'right') m.dir = 'left';
        if (Math.abs((m.lane + m.w / 2) - (n.lane + n.w / 2)) >= n.w) notes.push(m);
      }
      prev = { t, center: n.lane + n.w / 2, w: n.w, p: e.p, side: n.lane + n.w / 2 < 6 ? -1 : 1 };
    }
    notes.sort((a, b) => a.t - b.t || a.lane - b.lane);
    const chart = { bpm, offset: off, notes };
    chart.level = calcLevel(chart);
    return chart;
  }

  function calcLevel(chart) {
    const ns = chart.notes;
    if (ns.length < 2) return 1;
    const t0 = ns[0].t, t1 = ns[ns.length - 1].end || ns[ns.length - 1].t;
    const weight = n => 1 + (n.type === 'hold' ? 0.6 : 0) + (n.type === 'flick' ? 0.2 : 0);
    const total = ns.reduce((a, n) => a + weight(n), 0);
    const avg = total / Math.max(10, t1 - t0);
    let peak = 0;
    for (let i = 0, j = 0, sum = 0; i < ns.length; i++) {
      sum += weight(ns[i]);
      while (ns[i].t - ns[j].t > 2) { sum -= weight(ns[j]); j++; }
      peak = Math.max(peak, sum / 2);
    }
    return U.clamp(Math.round(2 + avg * 2.4 + peak * 0.95), 1, 37);
  }

  // 音声解析ができない場合 (YouTube) の BPM ベースのリズム生成
  function patternEvents(bpm, offset, duration, seed) {
    const rng = U.rng(seed >>> 0);
    const beat = 60 / bpm, step = beat / 4, bar = beat * 4;
    const ev = [];
    const nBars = Math.floor((duration - offset - 0.5) / bar);
    const energyCycle = [0.35, 0.55, 0.85, 0.9, 0.45, 0.6, 0.9, 0.95];
    let p = 0.5, energy = 0.4, pats = null;
    for (let b = 0; b < nBars; b++) {
      const t0 = offset + b * bar;
      if (b % 8 === 0) {
        energy = U.clamp(energyCycle[(b / 8) % energyCycle.length] + (rng() - 0.5) * 0.2, 0.2, 1);
        if (b > 0) ev.push({ t: t0, kind: 'crash', s: 1, accent: true });
        pats = null;
      }
      const dens = energy < 0.45 ? 'low' : energy < 0.75 ? 'mid' : 'high';
      if (!pats || b % 2 === 0) pats = rng.pick(RHYTHMS[dens]);
      pats.forEach(([st, len], k) => {
        p = U.clamp(p + rng.int(-2, 2) * 0.07, 0, 1);
        const last = b % 8 === 7 && k === pats.length - 1;
        ev.push({ t: t0 + st * step, kind: 'mel', s: 0.6 + (st % 4 === 0 ? 0.12 : st % 2 === 0 ? 0.05 : 0), p, d: len * step, accent: last });
      });
      [0, 8].forEach(s => ev.push({ t: t0 + s * step, kind: 'kick', s: 0.45 }));
      [4, 12].forEach(s => ev.push({ t: t0 + s * step, kind: 'snare', s: 0.5 }));
    }
    return ev;
  }

  return { generate, calcLevel, patternEvents, CFG };
})();
