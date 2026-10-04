'use strict';
/*
 * AI 作曲エンジン
 *  - コード進行・セクション構成・シード値から旋律/ドラム/ベース/パッド/アルペジオを自動生成
 *  - サンプル単位のシンセサイザーでオーディオをレンダリング (外部素材なし・完全オリジナル)
 *  - 生成した楽譜イベントは譜面自動生成にも使われる
 */

const RHYTHMS = {
  low: [
    [[0, 4], [4, 4], [8, 8]],
    [[0, 6], [6, 2], [8, 8]],
    [[0, 4], [4, 2], [6, 2], [8, 8]],
    [[0, 8], [8, 4], [12, 4]],
    [[2, 2], [4, 4], [8, 6], [14, 2]],
    [[0, 3], [3, 3], [6, 2], [8, 8]],
  ],
  mid: [
    [[0, 2], [2, 2], [4, 4], [8, 2], [10, 2], [12, 4]],
    [[0, 3], [3, 3], [6, 2], [8, 4], [12, 2], [14, 2]],
    [[0, 2], [2, 4], [6, 2], [8, 2], [10, 2], [12, 4]],
    [[0, 4], [4, 2], [6, 2], [8, 3], [11, 3], [14, 2]],
    [[0, 2], [2, 2], [4, 2], [6, 2], [8, 8]],
    [[2, 2], [4, 2], [6, 4], [10, 2], [12, 4]],
  ],
  high: [
    [[0, 1], [1, 1], [2, 2], [4, 2], [6, 2], [8, 1], [9, 1], [10, 2], [12, 2], [14, 2]],
    [[0, 2], [2, 1], [3, 1], [4, 2], [6, 2], [8, 2], [10, 1], [11, 1], [12, 4]],
    [[0, 2], [2, 2], [4, 1], [5, 1], [6, 2], [8, 3], [11, 3], [14, 2]],
    [[0, 3], [3, 3], [6, 1], [7, 1], [8, 2], [10, 2], [12, 1], [13, 1], [14, 2]],
    [[0, 1], [1, 1], [2, 1], [3, 1], [4, 2], [6, 2], [8, 4], [12, 2], [14, 2]],
    [[0, 2], [2, 2], [4, 2], [6, 1], [7, 1], [8, 2], [10, 2], [12, 2], [14, 1], [15, 1]],
  ],
};

const AI_SONGS = [
  {
    id: 'ai-neon-pulse', title: 'Neon Pulse', sub: 'ネオン・パルス', artist: 'OTO-AI Composer',
    bpm: 140, key: 9, mode: 'minor', style: 'synthpop', seed: 1401, range: [69, 84],
    colors: ['#22d3ee', '#a855f7'],
    desc: '夜の街を駆けるシンセポップ。サイドチェインの効いたサビが心地よい入門曲。',
    chords: {
      intro: ['Am', 'F', 'C', 'G'], verse: ['Am', 'F', 'C', 'G'], pre: ['Dm', 'Em', 'F', 'G'],
      chorus: ['FM7', 'G', 'Em', 'Am'], break: ['F', 'G', 'Am', 'Am'], outro: ['F', 'G', 'Am', 'Am'],
    },
    density: { intro: null, verse: 'low', pre: 'mid', chorus: 'mid', break: null, outro: 'mid' },
    arp: { break: 0.8, chorus: 0.35 },
    structure: [['intro', 4], ['verse', 8], ['pre', 4], ['chorus', 8], ['break', 4], ['verse', 8], ['pre', 4], ['chorus', 8], ['chorus', 8], ['outro', 4]],
  },
  {
    id: 'ai-starlight-runner', title: 'Starlight Runner', sub: 'スターライト・ランナー', artist: 'OTO-AI Composer',
    bpm: 172, key: 2, mode: 'major', style: 'dnb', seed: 1722, range: [66, 86],
    colors: ['#fbbf24', '#f43f5e'],
    desc: '王道進行で駆け抜ける疾走系ドラムンベース。16分の連打とロングに注意。',
    chords: {
      intro: ['GM7', 'A', 'F#m', 'Bm'], verse: ['D', 'A', 'Bm', 'F#m'], pre: ['G', 'F#m', 'Em', 'A'],
      chorus: ['GM7', 'A', 'F#m', 'Bm'], break: ['Bm', 'G', 'D', 'A'], outro: ['G', 'A', 'D', 'D'],
    },
    density: { intro: null, verse: 'mid', pre: 'mid', chorus: 'high', break: 'low', outro: 'mid' },
    arp: { chorus: 0.5, break: 0.6 },
    structure: [['intro', 8], ['verse', 8], ['pre', 8], ['chorus', 8], ['break', 4], ['verse', 8], ['pre', 8], ['chorus', 16], ['outro', 4]],
  },
  {
    id: 'ai-crimson-overdrive', title: 'Crimson Overdrive', sub: 'クリムゾン・オーバードライブ', artist: 'OTO-AI Composer',
    bpm: 186, key: 4, mode: 'minor', style: 'hardcore', seed: 1863, range: [64, 84],
    colors: ['#ef4444', '#7c3aed'],
    desc: '186BPMのハードコア。高速アルペジオと激しいフリックが襲いかかる最難関。',
    chords: {
      intro: ['Em', 'C', 'D', 'B'], verse: ['Em', 'C', 'D', 'B'], pre: ['Am', 'Em', 'C', 'B'],
      chorus: ['C', 'D', 'B', 'Em'], break: ['Am', 'C', 'D', 'B'], outro: ['C', 'D', 'Em', 'Em'],
    },
    density: { intro: null, verse: 'mid', pre: 'mid', chorus: 'high', break: 'low', outro: 'high' },
    arp: { verse: 0.45, pre: 0.6, chorus: 0.7, break: 0.8 },
    structure: [['intro', 8], ['verse', 8], ['pre', 8], ['chorus', 16], ['break', 8], ['pre', 4], ['chorus', 16], ['outro', 4]],
  },
];

const Composer = (() => {
  const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11] };
  const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  function parseChord(name) {
    const m = name.match(/^([A-G])([#b]?)(m|dim)?(M7|7)?$/);
    const base = (PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
    const iv = m[3] === 'm' ? [0, 3, 7] : m[3] === 'dim' ? [0, 3, 6] : [0, 4, 7];
    const ext = m[4] === 'M7' ? 11 : m[4] === '7' ? 10 : null;
    const pcs = iv.map(i => (base + i) % 12);
    return { root: base, iv, ext, pcs, all: ext != null ? pcs.concat([(base + ext) % 12]) : pcs };
  }

  function barScale(def, chord) {
    const sc = SCALES[def.mode].map(i => (i + def.key) % 12);
    for (const c of chord.all) {
      if (sc.includes(c)) continue;
      for (let i = 0; i < sc.length; i++) {
        const d = Math.abs(sc[i] - c);
        if (d === 1 || d === 11) { sc[i] = c; break; }
      }
    }
    return sc;
  }

  function allowedPitches(def, chord) {
    const sc = barScale(def, chord);
    const out = [];
    for (let m = def.range[0] - 2; m <= def.range[1] + 2; m++) if (sc.includes(m % 12)) out.push(m);
    return out;
  }

  function nearestIdx(list, v) {
    let bi = 0, bd = 1e9;
    for (let i = 0; i < list.length; i++) { const d = Math.abs(list[i] - v); if (d < bd) { bd = d; bi = i; } }
    return bi;
  }

  function makeMotif(rng, density, bars) {
    const notes = [];
    for (let b = 0; b < bars; b++) {
      const pat = rng.pick(RHYTHMS[density]);
      for (const [st, len] of pat) notes.push({ bar: b, step: st, len });
    }
    const n = notes.length, moves = [0];
    for (let i = 1; i < n; i++) {
      const up = i / n < 0.55;
      const r = rng();
      let mv = r < 0.16 ? 0 : r < 0.66 ? 1 : r < 0.9 ? 2 : rng.int(3, 4);
      if (!(up ? rng() < 0.7 : rng() < 0.3)) mv = -mv;
      moves.push(mv);
    }
    return { notes, moves, start: rng.int(0, 2) };
  }

  function variant(rng, m) {
    const v = { notes: m.notes.map(n => ({ ...n })), moves: m.moves.slice(), start: m.start };
    const n = v.moves.length;
    for (let i = Math.max(1, n - 2); i < n; i++) v.moves[i] = rng.int(-3, 3);
    return v;
  }

  // モチーフを具体的な音高へ
  function realize(def, motif, chords, prevMidi, cadence) {
    const out = [];
    const center = (def.range[0] + def.range[1]) / 2;
    let prev = prevMidi ?? center;
    motif.notes.forEach((nt, i) => {
      const chord = chords[nt.bar];
      const allowed = allowedPitches(def, chord);
      let pitch;
      if (i === 0) {
        const tones = allowed.filter(p => chord.pcs.includes(p % 12) && p >= def.range[0] && p <= def.range[1]);
        const target = prev + (motif.start - 1) * 3;
        pitch = tones[nearestIdx(tones, target)];
      } else {
        const pi = nearestIdx(allowed, prev);
        let idx = pi + motif.moves[i];
        if (allowed[idx] == null || allowed[idx] > def.range[1] || allowed[idx] < def.range[0]) idx = pi - motif.moves[i];
        idx = U.clamp(idx, 0, allowed.length - 1);
        pitch = allowed[idx];
        const strong = nt.step % 8 === 0 || nt.len >= 6;
        if (strong && !chord.all.includes(pitch % 12)) {
          const dir = Math.sign(motif.moves[i]) || 1;
          for (let k = 1; k < 4; k++) {
            const c = allowed[idx + dir * k];
            if (c != null && chord.all.includes(c % 12)) { pitch = c; break; }
            const c2 = allowed[idx - dir * k];
            if (c2 != null && chord.all.includes(c2 % 12)) { pitch = c2; break; }
          }
        }
      }
      let len = nt.len;
      const isLast = i === motif.notes.length - 1;
      if (cadence && isLast) {
        const roots = allowed.filter(p => p % 12 === chord.root && p >= def.range[0] - 2 && p <= def.range[1]);
        if (roots.length) pitch = roots[nearestIdx(roots, prev)];
        len = 16 - nt.step;
      }
      pitch = U.clamp(pitch, def.range[0] - 2, def.range[1] + 2);
      out.push({ bar: nt.bar, step: nt.step, len, midi: pitch, cad: cadence && isLast });
      prev = pitch;
    });
    return out;
  }

  function drumBar(style, type, bi, L) {
    const H = [];
    const add = (inst, steps, vel) => steps.forEach(s => H.push({ step: s, inst, vel }));
    const E8 = [0, 2, 4, 6, 8, 10, 12, 14], S16 = [...Array(16).keys()], OFF = [2, 6, 10, 14], FOUR = [0, 4, 8, 12];
    const last = bi === L - 1;
    const roll = (from, vel0, vel1) => { for (let s = from; s < 16; s++) add('snare', [s], vel0 + (vel1 - vel0) * (s - from) / (16 - from)); };
    if (bi === 0 && type !== 'intro') add('crash', [0], 1);
    if (style === 'synthpop') {
      if (type === 'intro') {
        if (bi >= L / 2) add('hat', E8, 0.35);
        if (bi >= L - 2) add('kick', [0, 8], 0.8);
        if (last) roll(8, 0.3, 0.8);
      } else if (type === 'verse') {
        add('kick', bi % 2 ? [0, 6, 8] : [0, 8, 10], 0.9); add('snare', [4, 12], 0.75); add('hat', E8, 0.4);
        if (bi % 8 === 7) add('snare', [13, 14, 15], 0.5);
      } else if (type === 'pre') {
        if (!last) { add('kick', [0, 8], 0.9); add('snare', [4, 12], 0.75); add('hat', S16, 0.22); }
        else { add('kick', FOUR, 0.9); roll(0, 0.25, 0.95); }
      } else if (type === 'chorus' || type === 'outro') {
        if (type === 'outro' && last) { add('kick', [0], 1); }
        else {
          add('kick', FOUR, 1); add('clap', [4, 12], 0.8); add('ohat', OFF, 0.32); add('hat', S16, 0.12);
          if (bi % 8 === 7) add('snare', [13, 14, 15], 0.55);
        }
      } else if (type === 'break') {
        if (bi % 2 === 0) add('kick', [0], 0.7);
        add('hat', E8, 0.25); add('clap', [12], 0.5);
        if (last) roll(8, 0.3, 0.85);
      }
    } else if (style === 'dnb') {
      if (type === 'intro') {
        if (bi >= 2) add('hat', S16, 0.18);
        if (bi >= L / 2) add('kick', [0, 10], 0.75);
        if (bi >= L / 2) add('snare', [4, 12], 0.5);
        if (last) roll(8, 0.35, 0.9);
      } else if (type === 'verse') {
        add('kick', bi % 4 === 3 ? [0, 10, 11] : [0, 10], 0.9); add('snare', [4, 12], 0.8);
        add('hat', E8, 0.35); add('snare', [7, 15], 0.18);
        if (bi % 8 === 7) add('snare', [13, 14, 15], 0.5);
      } else if (type === 'pre') {
        if (bi < L - 1) { add('kick', [0, 8], 0.9); add('snare', [4, 12], 0.8); add('hat', S16, 0.2); }
        if (bi === L - 2) add('snare', [14, 15], 0.5);
        if (last) { add('kick', [0, 8], 0.9); roll(0, 0.25, 1); }
      } else if (type === 'chorus' || type === 'outro') {
        if (type === 'outro' && last) add('kick', [0], 1);
        else {
          add('kick', [0, 10], 1); add('snare', [4, 12], 0.9); add('hat', S16, 0.22); add('ohat', OFF, 0.2);
          if (bi % 8 === 7) add('snare', [13, 14, 15], 0.6);
        }
      } else if (type === 'break') {
        add('kick', [0], 0.6); if (bi % 2) add('snare', [12], 0.5); add('hat', E8, 0.2);
        if (last) roll(8, 0.3, 0.9);
      }
    } else { // hardcore
      if (type === 'intro') {
        if (bi >= L / 2) add('kick', FOUR, 0.85);
        add('ohat', OFF, bi >= 2 ? 0.28 : 0.12);
        if (last) roll(0, 0.2, 0.9);
      } else if (type === 'verse') {
        add('kick', FOUR, 1); add('clap', [4, 12], 0.75); add('ohat', OFF, 0.28); add('hat', S16, 0.1);
        if (bi % 8 === 7) add('snare', [14, 15], 0.6);
      } else if (type === 'pre') {
        add('kick', FOUR, 0.95);
        if (bi < L / 2) { add('clap', [4, 12], 0.7); add('hat', S16, 0.15); }
        else if (bi < L - 2) add('snare', E8, 0.35 + 0.1 * (bi - L / 2));
        else roll(0, 0.3 + 0.3 * (bi - (L - 2)), 0.7 + 0.3 * (bi - (L - 2)));
      } else if (type === 'chorus' || type === 'outro') {
        if (type === 'outro' && last) add('kick', [0], 1);
        else {
          add('kick', FOUR, 1); add('clap', [4, 12], 0.85); add('ohat', OFF, 0.3); add('hat', S16, 0.14);
          if (bi % 8 === 7) add('snare', [12, 13, 14, 15], 0.6);
        }
      } else if (type === 'break') {
        add('ohat', OFF, 0.14); add('clap', [12], 0.4);
        if (bi >= L - 2) roll(bi === L - 1 ? 0 : 8, 0.25, 0.85);
      }
    }
    return H;
  }

  function bassBar(style, type, bi, L) {
    const B = [];
    const E8 = [0, 2, 4, 6, 8, 10, 12, 14], OFF = [2, 6, 10, 14];
    if (style === 'synthpop') {
      if (type === 'intro') { if (bi >= L / 2) B.push({ step: 0, len: 16, oct: 0, vel: 0.5 }); }
      else if (type === 'verse' || type === 'pre') E8.forEach((s, k) => B.push({ step: s, len: 2, oct: k === 3 || k === 7 ? 1 : 0, vel: 0.55 }));
      else if (type === 'chorus' || (type === 'outro' && bi < L - 1)) E8.forEach((s, k) => B.push({ step: s, len: 2, oct: k % 2, vel: 0.65 }));
      else if (type === 'break') B.push({ step: 0, len: 16, oct: 0, vel: 0.45 });
    } else if (style === 'dnb') {
      if (type === 'intro') { if (bi >= L / 2) B.push({ step: 0, len: 16, oct: 0, vel: 0.5 }); }
      else if (type === 'verse') { B.push({ step: 0, len: 10, oct: 0, vel: 0.6 }); B.push({ step: 10, len: 6, oct: 0, vel: 0.6 }); }
      else if (type === 'pre') E8.forEach(s => B.push({ step: s, len: 2, oct: 0, vel: 0.55 }));
      else if (type === 'chorus' || (type === 'outro' && bi < L - 1)) { B.push({ step: 0, len: 6, oct: 0, vel: 0.7 }); B.push({ step: 6, len: 4, oct: 1, vel: 0.6 }); B.push({ step: 10, len: 6, oct: 0, vel: 0.7 }); }
      else if (type === 'break') B.push({ step: 0, len: 16, oct: 0, vel: 0.45 });
    } else {
      if (type === 'intro') { if (bi >= L / 2) OFF.forEach(s => B.push({ step: s, len: 2, oct: 0, vel: 0.55 })); }
      else if (type === 'verse' || type === 'chorus' || (type === 'outro' && bi < L - 1)) OFF.forEach(s => B.push({ step: s, len: 2, oct: 0, vel: 0.7 }));
      else if (type === 'pre') { if (bi < L - 2) OFF.forEach(s => B.push({ step: s, len: 2, oct: 0, vel: 0.6 })); }
      else if (type === 'break') B.push({ step: 0, len: 16, oct: 0, vel: 0.45 });
    }
    return B;
  }

  /* ---------- 楽曲スケジュール (軽量・決定的) ---------- */
  const cache = {};
  function schedule(def) {
    if (cache[def.id]) return cache[def.id];
    const rng = U.rng(def.seed);
    const bpm = def.bpm, beat = 60 / bpm, stepSec = beat / 4, barSec = beat * 4;
    const offset = 0.6;
    const sections = [];
    let bar = 0;
    for (const [type, bars] of def.structure) { sections.push({ type, bar, bars, start: offset + bar * barSec }); bar += bars; }
    const totalBars = bar;
    const endT = offset + totalBars * barSec;
    const motifs = {};
    const getMotifs = (type, density) => {
      if (!motifs[type]) motifs[type] = (() => {
        const A = makeMotif(rng, density, 2);
        return { A, A2: variant(rng, A), B: makeMotif(rng, density, 2), A3: variant(rng, A) };
      })();
      return motifs[type];
    };
    const drums = [], bass = [], pads = [], mel = [], arp = [], events = [], duckKicks = [];
    const tAt = (b, s) => offset + b * barSec + s * stepSec;
    let prevMidi = null;
    const bassMidi = pc => 36 + ((pc - 4 + 12) % 12) + 4; // E2..D#3

    for (const sec of sections) {
      const prog = def.chords[sec.type].map(parseChord);
      const chordOf = bi => prog[bi % prog.length];
      const duck = def.style === 'hardcore' ? sec.type !== 'break' : def.style === 'synthpop' ? (sec.type === 'chorus' || sec.type === 'outro') : false;
      for (let bi = 0; bi < sec.bars; bi++) {
        const b = sec.bar + bi;
        const ch = chordOf(bi);
        // drums
        for (const h of drumBar(def.style, sec.type, bi, sec.bars)) {
          const t = tAt(b, h.step);
          drums.push({ t, inst: h.inst, vel: h.vel });
          if (h.inst === 'kick') {
            if (duck) duckKicks.push(t);
            events.push({ t, kind: 'kick', s: 0.4 + (h.step === 0 ? 0.08 : 0) + h.vel * 0.04 });
          } else if (h.inst === 'snare' || h.inst === 'clap') {
            const main = h.step === 4 || h.step === 12;
            if (main || h.vel >= 0.4) events.push({ t, kind: main ? 'snare' : 'fill', s: main ? 0.5 : 0.3 + h.vel * 0.12 });
          } else if (h.inst === 'crash') events.push({ t, kind: 'crash', s: 1, accent: true });
        }
        // bass
        for (const n of bassBar(def.style, sec.type, bi, sec.bars)) {
          bass.push({ t: tAt(b, n.step), dur: n.len * stepSec, midi: bassMidi(ch.root) + n.oct * 12, vel: n.vel, duck });
        }
        // pad
        const padVel = { intro: 0.7, verse: 0.6, pre: 0.8, chorus: 1, break: 0.9, outro: 0.9 }[sec.type];
        if (!(sec.type === 'outro' && bi === sec.bars - 1)) {
          const notes = ch.all.map(pc => 55 + ((pc - 7 + 12) % 12));
          pads.push({ t: tAt(b, 0), dur: barSec, notes, vel: padVel, duck });
        }
        // arp
        const arpVel = def.arp[sec.type];
        if (arpVel && !(sec.type === 'outro')) {
          const tones = ch.pcs.map(pc => 69 + ((pc - 9 + 12) % 12)).sort((a, c) => a - c);
          tones.push(tones[0] + 12);
          const order = def.style === 'hardcore' ? [0, 1, 2, 3, 2, 1, 2, 3] : [0, 2, 1, 3, 2, 1, 3, 2];
          for (let s = 0; s < 16; s++) {
            const midi = tones[order[s % 8]];
            const t = tAt(b, s);
            arp.push({ t, dur: stepSec, midi, vel: arpVel * (s % 4 === 0 ? 1 : 0.75), pan: s % 2 ? 0.45 : -0.45 });
            events.push({ t, kind: 'arp', s: 0.28 + (s % 4 === 0 ? 0.06 : 0), p: (midi - 60) / 30 });
          }
        }
      }
      // melody
      const dens = def.density[sec.type];
      if (dens) {
        const M = getMotifs(sec.type === 'outro' ? 'chorus' : sec.type, sec.type === 'outro' ? def.density.chorus : dens);
        let plan;
        if (sec.type === 'outro') plan = [[M.A, false], [M.A3, true]];
        else if (sec.bars === 4) plan = [[M.A, false], [M.A3, true]];
        else {
          plan = [[M.A, false], [M.A2, false], [M.B, false], [M.A3, true]];
          if (sec.bars === 16) plan = plan.concat(plan);
        }
        plan.forEach(([motif, cad], pi) => {
          const chords = [chordOf(pi * 2), chordOf(pi * 2 + 1)];
          const notes = realize(def, motif, chords, prevMidi, cad);
          for (const n of notes) {
            const b = sec.bar + pi * 2 + n.bar;
            if (sec.type === 'outro' && b >= sec.bar + sec.bars - 1 && n.step > 0) continue;
            const t = tAt(b, n.step), dur = n.len * stepSec;
            mel.push({ t, dur, midi: n.midi, type: sec.type, vel: sec.type === 'chorus' || sec.type === 'outro' ? 1 : 0.85 });
            const s = 0.62 + (n.step % 4 === 0 ? 0.12 : n.step % 2 === 0 ? 0.05 : 0) + (sec.type === 'chorus' ? 0.08 : 0) + (n.len >= 4 ? 0.05 : 0);
            events.push({ t, kind: 'mel', s, p: (n.midi - def.range[0]) / (def.range[1] - def.range[0]), d: dur, accent: n.cad });
            prevMidi = n.midi;
          }
        });
      }
    }
    // フィナーレ
    const lastCh = parseChord(def.chords.outro[def.chords.outro.length - 1]);
    drums.push({ t: endT, inst: 'crash', vel: 1 }, { t: endT, inst: 'kick', vel: 1 });
    pads.push({ t: endT, dur: barSec * 1.5, notes: lastCh.all.map(pc => 55 + ((pc - 7 + 12) % 12)), vel: 1, duck: false });
    bass.push({ t: endT, dur: barSec * 1.5, midi: bassMidi(lastCh.root), vel: 0.7, duck: false });
    events.push({ t: endT, kind: 'crash', s: 1, accent: true, final: true });

    const out = { def, bpm, beat, stepSec, barSec, offset, sections, totalBars, endT, duration: endT + barSec * 2 + 0.5, drums, bass, pads, mel, arp, events, duckKicks };
    cache[def.id] = out;
    return out;
  }

  /* ---------- シンセサイザー ---------- */
  function polyblep(t, dt) {
    if (t < dt) { t /= dt; return t + t - t * t - 1; }
    if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
    return 0;
  }

  class Synth {
    constructor(sr, seconds) {
      this.sr = sr; this.n = Math.ceil(sr * seconds);
      this.L = new Float32Array(this.n); this.R = new Float32Array(this.n);
      this.FX = new Float32Array(this.n);   // リバーブ送り
      this.DS = new Float32Array(this.n);   // ディレイ送り
      this.duck = new Float32Array(this.n).fill(1);
      this.seed = 22222;
    }
    noise() { let s = this.seed; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this.seed = s; return ((s >>> 0) / 4294967296) * 2 - 1; }
    setDuck(times, depth, len) {
      const sr = this.sr, n = Math.floor(len * sr);
      for (const t of times) {
        const i0 = Math.floor(t * sr);
        for (let j = 0; j < n; j++) {
          const i = i0 + j; if (i >= this.n) break;
          const x = 1 - j / n;
          const g = 1 - depth * x * x;
          if (g < this.duck[i]) this.duck[i] = g;
        }
      }
    }
    _out(i, v, pl, pr, fx, ds) {
      this.L[i] += v * pl; this.R[i] += v * pr;
      if (fx) this.FX[i] += v * fx;
      if (ds) this.DS[i] += v * ds;
    }
    kick(t, vel, hard) {
      const sr = this.sr, i0 = Math.floor(t * sr), n = Math.floor((hard ? 0.42 : 0.32) * sr);
      let ph = 0;
      for (let j = 0; j < n; j++) {
        const i = i0 + j; if (i >= this.n) break;
        const tt = j / sr;
        const f = hard ? 50 + 190 * Math.exp(-tt * 32) : 46 + 120 * Math.exp(-tt * 28);
        ph += f / sr;
        let s = Math.sin(2 * Math.PI * ph);
        const env = Math.exp(-tt * (hard ? 6.5 : 9));
        if (hard) s = Math.tanh(s * 3.2) * 0.85;
        const v = (s * env + this.noise() * Math.exp(-tt * 400) * 0.3) * vel * 0.95;
        this.L[i] += v; this.R[i] += v;
      }
    }
    snare(t, vel) {
      const sr = this.sr, i0 = Math.floor(t * sr), n = Math.floor(0.26 * sr);
      let ph = 0, pn = 0;
      for (let j = 0; j < n; j++) {
        const i = i0 + j; if (i >= this.n) break;
        const tt = j / sr;
        ph += (175 + 40 * Math.exp(-tt * 40)) / sr;
        const nz = this.noise(); const hp = nz - pn; pn = nz;
        const v = (Math.sin(2 * Math.PI * ph) * Math.exp(-tt * 25) * 0.55 + hp * Math.exp(-tt * 15) * 0.5) * vel * 0.6;
        this._out(i, v, 0.7, 0.7, 0.18, 0);
      }
    }
    clap(t, vel) {
      const sr = this.sr, i0 = Math.floor(t * sr), n = Math.floor(0.3 * sr);
      let pn = 0, lp = 0;
      for (let j = 0; j < n; j++) {
        const i = i0 + j; if (i >= this.n) break;
        const tt = j / sr;
        const nz = this.noise(); const hp = nz - pn; pn = nz; lp += (hp - lp) * 0.35;
        let env = Math.exp(-tt * 160);
        if (tt >= 0.011) env = Math.max(env, Math.exp(-(tt - 0.011) * 160));
        if (tt >= 0.022) env = Math.max(env, Math.exp(-(tt - 0.022) * 160));
        if (tt >= 0.03) env = Math.max(env, Math.exp(-(tt - 0.03) * 16) * 0.75);
        const v = lp * env * vel * 0.9;
        this._out(i, v, 0.7, 0.7, 0.25, 0);
      }
    }
    hat(t, vel, open) {
      const sr = this.sr, i0 = Math.floor(t * sr), n = Math.floor((open ? 0.3 : 0.06) * sr);
      let p1 = 0, p2 = 0;
      for (let j = 0; j < n; j++) {
        const i = i0 + j; if (i >= this.n) break;
        const tt = j / sr;
        const nz = this.noise(); const h1 = nz - p1; p1 = nz; const h2 = h1 - p2; p2 = h1;
        const v = h2 * Math.exp(-tt * (open ? 10 : 55)) * vel * 0.32;
        this._out(i, v, 0.6, 0.8, 0.05, 0);
      }
    }
    crash(t, vel) {
      const sr = this.sr, i0 = Math.floor(t * sr), n = Math.floor(2.2 * sr);
      let pl = 0, pr = 0;
      for (let j = 0; j < n; j++) {
        const i = i0 + j; if (i >= this.n) break;
        const tt = j / sr;
        const env = Math.exp(-tt * 2.4) * vel * 0.3;
        const a = this.noise(), b = this.noise();
        const hl = (a - pl) * env, hr = (b - pr) * env; pl = a; pr = b;
        this.L[i] += hl; this.R[i] += hr;
        this.FX[i] += (hl + hr) * 0.1;
      }
    }
    /* 汎用シンセボイス */
    tone(t, dur, midi, vel, o) {
      const sr = this.sr, f0 = U.mtof(midi);
      const A = o.a ?? 0.005, D = o.d ?? 0.1, S = o.s ?? 0.7, Rl = o.r ?? 0.08;
      const i0 = Math.floor(t * sr), n = Math.floor((dur + Rl) * sr);
      const det = o.det || [0];
      const ph = det.map((_, k) => (k * 0.373) % 1);
      const inc = det.map(c => f0 * Math.pow(2, c / 1200) / sr);
      const wave = o.wave || 'saw';
      const cut0 = o.cut ?? 4000, cEnv = o.cutEnv ?? 0, cDec = o.cutDecay ?? 8;
      const pan = o.pan ?? 0;
      const pl = Math.cos((pan + 1) * Math.PI / 4), pr = Math.sin((pan + 1) * Math.PI / 4);
      const fx = o.fx || 0, ds = o.ds || 0, sub = o.sub || 0, useDuck = !!o.duck;
      const g = vel / det.length;
      const envAt = tt => tt < A ? tt / A : tt < A + D ? 1 - (1 - S) * ((tt - A) / D) : S;
      const relLevel = envAt(dur);
      let y1 = 0, y2 = 0, a = 0, subPh = 0;
      for (let j = 0; j < n; j++) {
        const i = i0 + j; if (i >= this.n) break; if (i < 0) continue;
        const tt = j / sr;
        const env = tt <= dur ? envAt(tt) : relLevel * Math.max(0, 1 - (tt - dur) / Rl);
        if ((j & 15) === 0) {
          const fc = Math.min(sr * 0.42, cut0 * (1 + cEnv * Math.exp(-tt * cDec)));
          a = 1 - Math.exp(-2 * Math.PI * fc / sr);
        }
        const vib = o.vib && tt > 0.2 ? 1 + 0.0035 * Math.sin(2 * Math.PI * 5.5 * tt) : 1;
        let s = 0;
        for (let k = 0; k < det.length; k++) {
          const dt = inc[k] * vib; let p = ph[k];
          if (wave === 'saw') s += 2 * p - 1 - polyblep(p, dt);
          else if (wave === 'square') s += (p < 0.5 ? 1 : -1) + polyblep(p, dt) - polyblep((p + 0.5) % 1, dt);
          else if (wave === 'tri') s += 1 - 4 * Math.abs(p - 0.5);
          else s += Math.sin(2 * Math.PI * p);
          p += dt; if (p >= 1) p -= 1; ph[k] = p;
        }
        y1 += a * (s - y1); y2 += a * (y1 - y2);
        let v = y2;
        if (sub) { subPh += f0 / 2 / sr; if (subPh >= 1) subPh -= 1; v += Math.sin(2 * Math.PI * subPh) * sub * det.length; }
        v *= env * g;
        if (useDuck) v *= this.duck[i];
        this._out(i, v, pl, pr, fx, ds);
      }
    }
    effects(beat) {
      const sr = this.sr, n = this.n;
      // ピンポンディレイ (付点8分)
      const d = Math.floor(beat * 0.75 * sr), fb = 0.38;
      const bl = new Float32Array(d), br = new Float32Array(d);
      for (let i = 0, k = 0; i < n; i++, k = (k + 1) % d) {
        const outL = bl[k], outR = br[k];
        bl[k] = this.DS[i] + outR * fb;
        br[k] = outL;
        this.L[i] += outL * 0.32; this.R[i] += outR * 0.32;
        this.FX[i] += (outL + outR) * 0.15;
      }
      // リバーブ (Freeverb 風)
      const scale = sr / 44100;
      const combs = [1116, 1188, 1277, 1356, 1422, 1491].map(x => Math.floor(x * scale));
      const aps = [556, 441].map(x => Math.floor(x * scale));
      const mk = (spread) => ({
        c: combs.map(l => ({ b: new Float32Array(l + spread), k: 0, f: 0 })),
        a: aps.map(l => ({ b: new Float32Array(l + spread), k: 0 })),
      });
      const chs = [mk(0), mk(23)];
      const room = 0.84, damp = 0.25, wet = 0.22;
      for (let i = 0; i < n; i++) {
        const x = this.FX[i] * 0.3;
        for (let c = 0; c < 2; c++) {
          const ch = chs[c];
          let y = 0;
          for (const cb of ch.c) {
            const o = cb.b[cb.k];
            cb.f = o * (1 - damp) + cb.f * damp;
            cb.b[cb.k] = x + cb.f * room;
            cb.k = (cb.k + 1) % cb.b.length;
            y += o;
          }
          for (const ap of ch.a) {
            const o = ap.b[ap.k];
            ap.b[ap.k] = y + o * 0.5;
            ap.k = (ap.k + 1) % ap.b.length;
            y = o - y;
          }
          if (c === 0) this.L[i] += y * wet; else this.R[i] += y * wet;
        }
      }
    }
    master() {
      let peak = 0;
      for (let i = 0; i < this.n; i++) { const a = Math.max(Math.abs(this.L[i]), Math.abs(this.R[i])); if (a > peak) peak = a; }
      const g = 1.5 / (peak || 1);
      for (let i = 0; i < this.n; i++) { this.L[i] = Math.tanh(this.L[i] * g) * 0.9; this.R[i] = Math.tanh(this.R[i] * g) * 0.9; }
    }
  }

  const TIMBRE = {
    synthpop: {
      lead: { wave: 'square', det: [-7, 7], cut: 2400, cutEnv: 1.6, cutDecay: 9, a: 0.004, d: 0.15, s: 0.6, r: 0.09, vib: true, fx: 0.28, ds: 0.2 },
      leadC: { wave: 'saw', det: [-11, 0, 11], cut: 3600, cutEnv: 1.5, cutDecay: 8, a: 0.004, d: 0.18, s: 0.65, r: 0.1, vib: true, fx: 0.3, ds: 0.22 },
      bass: { wave: 'saw', det: [0], sub: 0.7, cut: 520, cutEnv: 3, cutDecay: 14, a: 0.003, d: 0.1, s: 0.7, r: 0.03 },
      pad: { wave: 'saw', det: [-14, 0, 14], cut: 1900, a: 0.22, d: 0.3, s: 0.85, r: 0.35, fx: 0.4 },
      arp: { wave: 'square', det: [0], cut: 2600, cutEnv: 3, cutDecay: 22, a: 0.002, d: 0.13, s: 0, r: 0.05, fx: 0.3, ds: 0.3 },
      octave: false, kickHard: false, leadVol: 0.2,
    },
    dnb: {
      lead: { wave: 'saw', det: [-8, 8], cut: 2600, cutEnv: 1.6, cutDecay: 10, a: 0.003, d: 0.14, s: 0.6, r: 0.08, vib: true, fx: 0.26, ds: 0.2 },
      leadC: { wave: 'saw', det: [-12, 0, 12], cut: 4200, cutEnv: 1.3, cutDecay: 9, a: 0.003, d: 0.16, s: 0.65, r: 0.08, vib: true, fx: 0.3, ds: 0.22 },
      bass: { wave: 'saw', det: [-16, 16], sub: 0.9, cut: 420, cutEnv: 1.5, cutDecay: 6, a: 0.005, d: 0.2, s: 0.8, r: 0.05 },
      pad: { wave: 'saw', det: [-15, 0, 15], cut: 2200, a: 0.3, d: 0.3, s: 0.85, r: 0.4, fx: 0.45 },
      arp: { wave: 'tri', det: [0], cut: 5000, cutEnv: 1, cutDecay: 20, a: 0.002, d: 0.1, s: 0, r: 0.05, fx: 0.35, ds: 0.3 },
      octave: true, kickHard: false, leadVol: 0.19,
    },
    hardcore: {
      lead: { wave: 'saw', det: [-10, 10], cut: 2800, cutEnv: 1.8, cutDecay: 10, a: 0.003, d: 0.12, s: 0.6, r: 0.07, vib: true, fx: 0.25, ds: 0.18 },
      leadC: { wave: 'saw', det: [-14, -5, 5, 14], cut: 4500, cutEnv: 1.2, cutDecay: 9, a: 0.003, d: 0.14, s: 0.7, r: 0.07, vib: true, fx: 0.28, ds: 0.2 },
      bass: { wave: 'saw', det: [-9, 9], sub: 0.5, cut: 900, cutEnv: 2.5, cutDecay: 18, a: 0.002, d: 0.08, s: 0.6, r: 0.03 },
      pad: { wave: 'saw', det: [-16, 0, 16], cut: 2400, a: 0.18, d: 0.3, s: 0.85, r: 0.3, fx: 0.4 },
      arp: { wave: 'saw', det: [-6, 6], cut: 3000, cutEnv: 2.5, cutDecay: 24, a: 0.002, d: 0.1, s: 0, r: 0.04, fx: 0.25, ds: 0.28 },
      octave: true, kickHard: true, leadVol: 0.19,
    },
  };

  /* オーディオレンダリング (重いので進捗コールバック付き) */
  async function render(def, engine, onProgress = () => {}, gate = null) {
    const sc = schedule(def);
    const sr = 44100;
    const syn = new Synth(sr, sc.duration);
    const T = TIMBRE[def.style];
    syn.setDuck(sc.duckKicks, def.style === 'hardcore' ? 0.75 : 0.65, sc.beat * 0.8);
    const jobs = [];
    const chunk = (arr, fn, size = 40) => { for (let i = 0; i < arr.length; i += size) jobs.push(() => arr.slice(i, i + size).forEach(fn)); };
    chunk(sc.pads, p => p.notes.forEach((m, k) => syn.tone(p.t, p.dur, m, 0.11 * p.vel, { ...T.pad, duck: p.duck, pan: (k - 1) * 0.35 })), 8);
    chunk(sc.bass, b => syn.tone(b.t, b.dur, b.midi, 0.36 * b.vel, { ...T.bass, duck: b.duck }));
    chunk(sc.mel, m => {
      const ch = m.type === 'chorus' || m.type === 'outro';
      syn.tone(m.t, m.dur * 0.94, m.midi, T.leadVol * m.vel, ch ? T.leadC : T.lead);
      if (ch && T.octave) syn.tone(m.t, m.dur * 0.94, m.midi + 12, T.leadVol * 0.3, { ...T.leadC, pan: 0.2 });
    });
    chunk(sc.arp, a => syn.tone(a.t, a.dur * 0.9, a.midi, 0.085 * a.vel, { ...T.arp, pan: a.pan }), 120);
    chunk(sc.drums, d => {
      if (d.inst === 'kick') syn.kick(d.t, d.vel, T.kickHard);
      else if (d.inst === 'snare') syn.snare(d.t, d.vel);
      else if (d.inst === 'clap') syn.clap(d.t, d.vel);
      else if (d.inst === 'hat') syn.hat(d.t, d.vel, false);
      else if (d.inst === 'ohat') syn.hat(d.t, d.vel, true);
      else if (d.inst === 'crash') syn.crash(d.t, d.vel);
    }, 150);
    const total = jobs.length + 3;
    for (let i = 0; i < jobs.length; i++) {
      if (gate) await gate();
      jobs[i]();
      onProgress((i + 1) / total);
      await U.tick();
    }
    if (gate) await gate();
    syn.effects(sc.beat); onProgress((jobs.length + 2) / total); await U.tick();
    syn.master(); onProgress(1);
    const ctx = engine.ensure();
    const buf = ctx.createBuffer(2, syn.n, sr);
    buf.copyToChannel(syn.L, 0); buf.copyToChannel(syn.R, 1);
    return buf;
  }

  return { schedule, render, parseChord };
})();
