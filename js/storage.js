'use strict';
/* IndexedDB: 取り込んだ曲 (音声Blob/YouTube ID) と譜面を保存 */
const DB = {
  _p: null,
  open() {
    if (this._p) return this._p;
    this._p = new Promise((res, rej) => {
      if (!window.indexedDB) { rej(new Error('IndexedDB が使えません')); return; }
      const req = indexedDB.open('oto-stage', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return this._p;
  },
  async _tx(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('songs', mode);
      const st = tx.objectStore('songs');
      const r = fn(st);
      tx.oncomplete = () => res(r && 'result' in r ? r.result : undefined);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  },
  getAll() { return this._tx('readonly', st => st.getAll()); },
  get(id) { return this._tx('readonly', st => st.get(id)); },
  put(song) { return this._tx('readwrite', st => st.put(song)); },
  del(id) { return this._tx('readwrite', st => st.delete(id)); },
};

/* 設定 (localStorage) */
const Settings = {
  defaults: {
    speed: 8.0,          // ノーツ速度 1.0〜12.0
    offset: 0,           // ms (+ で判定を遅らせる = 音が遅れて聞こえる環境向け)
    musicVol: 0.9,
    seVol: 0.6,
    auto: false,
    keys: ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'],
    showKeys: true,
    noteSize: 1.0,
    effects: true,
    ytOffset: 0,         // ms YouTube 再生時に追加で加えるオフセット (YouTube はプレイヤー側の遅延が別にあるため)
    autoOffset: true,    // プレイ結果からオフセットを自動補正
    fullscreen: true,    // スマホでプレイ時に全画面・横向き
    vibrate: false,      // タップ時に振動 (Android)
    lowQuality: false,   // 軽量モード (解像度・光の演出を抑える)
    touchWide: 1.0,      // タッチ判定の広さ (レーン単位の余白)
    calibrated: false,
  },
  data: null,
  load() {
    let d = {};
    try { d = JSON.parse(localStorage.getItem('oto-settings') || '{}'); } catch (e) { d = {}; }
    this.data = Object.assign({}, this.defaults, d);
    if (!Array.isArray(this.data.keys) || this.data.keys.length !== 6) this.data.keys = this.defaults.keys.slice();
    return this.data;
  },
  // 音源の種類に応じたオフセット (秒)
  offsetFor(kind) {
    const d = this.data;
    return ((d.offset || 0) + (kind === 'youtube' ? d.ytOffset || 0 : 0)) / 1000;
  },
  save() {
    try { localStorage.setItem('oto-settings', JSON.stringify(this.data)); } catch (e) { /* ignore */ }
  },
};

/* ハイスコア */
const Best = {
  key(songId, diff) { return 'oto-best:' + songId + ':' + diff; },
  get(songId, diff) {
    try { return JSON.parse(localStorage.getItem(this.key(songId, diff)) || 'null'); } catch (e) { return null; }
  },
  submit(songId, diff, r) {
    const prev = this.get(songId, diff);
    const rec = {
      score: Math.max(prev?.score || 0, r.score),
      fc: !!(prev?.fc || r.fc),
      ap: !!(prev?.ap || r.ap),
      clear: !!(prev?.clear || r.clear),
    };
    try { localStorage.setItem(this.key(songId, diff), JSON.stringify(rec)); } catch (e) { /* ignore */ }
    return { rec, isNew: !prev || r.score > prev.score };
  },
};
