// Memue — Markdownメモエディタ。保存先は Dropbox API か、このPCのローカルフォルダ。
'use strict';
const CFG = window.MEMUE_CONFIG || {};
const ROOT = (CFG.root || '').replace(/\/+$/, '');
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const pathOf = (name) => ROOT + '/' + name;
const bare = (name) => name.replace(/\.md$/i, '');
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

// ---------- 端末内の保存領域 (IndexedDB) ----------
// texts: 本文キャッシュ / kv: ローカルフォルダのハンドルなど
const idb = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('memue', 2);
    r.onupgradeneeded = () => { for (const s of ['texts', 'kv']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const run = async (store, mode, fn, fallback) => {
    try { const s = (await open()).transaction(store, mode).objectStore(store); return await new Promise((res, rej) => fn(s, res, rej)); } catch { return fallback; }
  };
  const simple = (store, mode, op) => run(store, mode, (s, res, rej) => { const q = op(s); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  return {
    get: (store, k) => simple(store, 'readonly', (s) => s.get(k)),
    put: (store, k, v) => simple(store, 'readwrite', (s) => s.put(v, k)),
    del: (store, k) => simple(store, 'readwrite', (s) => s.delete(k)),
    clear: (store) => simple(store, 'readwrite', (s) => s.clear()),
    all: (store) => run(store, 'readonly', (s, res, rej) => { const k = s.getAllKeys(), v = s.getAll(); v.onsuccess = () => res(k.result.map((key, i) => [key, v.result[i]])); v.onerror = () => rej(v.error); }, []),
  };
})();

// ---------- テキストの変換（元ファイルの改行コード・BOMを維持） ----------
function decodeBuf(buf) {
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const raw = new TextDecoder('utf-8').decode(buf);
  return { bom, crlf: raw.includes('\r\n'), text: raw.replace(/\r\n/g, '\n') };
}
function encodeText(text, fmt) {
  let out = text.replace(/\r\n/g, '\n');
  if (fmt && fmt.crlf) out = out.replace(/\n/g, '\r\n');
  if (fmt && fmt.bom) out = '﻿' + out;
  return new TextEncoder().encode(out);
}
const conflictErr = () => Object.assign(new Error('conflict'), { status: 409, summary: 'path/conflict' });
const isConflict = (e) => e.status === 409 && /conflict/.test(e.summary || '');

// ---------- Dropbox 認証 (OAuth 2 PKCE・シークレット不要) ----------
const LS = 'memue.dbx';
let auth = null;
try { auth = JSON.parse(lsGet(LS) || 'null'); } catch {}
const saveAuth = () => lsSet(LS, auth ? JSON.stringify(auth) : null);
const redirectUri = location.origin + location.pathname;
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function login() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem('memue.pkce', JSON.stringify({ verifier, state }));
  const u = new URL('https://www.dropbox.com/oauth2/authorize');
  u.search = new URLSearchParams({
    client_id: CFG.appKey, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256',
    token_access_type: 'offline', redirect_uri: redirectUri, state,
  });
  location.href = u;
}
async function tokenReq(params) {
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body: new URLSearchParams(Object.assign({ client_id: CFG.appKey }, params)) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error_description || j.error || '認証に失敗しました'); e.status = r.status; throw e; }
  return j;
}
async function finishLogin(code, state) {
  let pk = null; try { pk = JSON.parse(sessionStorage.getItem('memue.pkce')); } catch {}
  sessionStorage.removeItem('memue.pkce');
  if (!pk || pk.state !== state) throw new Error('認証の照合に失敗しました。もう一度接続してください。');
  const j = await tokenReq({ grant_type: 'authorization_code', code, code_verifier: pk.verifier, redirect_uri: redirectUri });
  auth = { refresh: j.refresh_token, access: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  saveAuth();
}
let refreshing = null;
async function accessToken() {
  if (!auth) throw signedOut();
  if (auth.access && Date.now() < auth.exp - 60000) return auth.access;
  refreshing = refreshing || (async () => {
    try {
      const j = await tokenReq({ grant_type: 'refresh_token', refresh_token: auth.refresh });
      auth.access = j.access_token; auth.exp = Date.now() + j.expires_in * 1000; saveAuth();
    } catch (e) { if (e.status === 400 || e.status === 401) throw signedOut(); throw e; }
    finally { refreshing = null; }
  })();
  await refreshing;
  return auth.access;
}
function signedOut() { // 接続が無効になった（Dropbox側で解除された等）
  auth = null; saveAuth();
  if (!$('app').hidden) location.reload();
  return new Error('Dropbox との接続が切れました。再接続してください。');
}

// ---------- 保存先 1: Dropbox API ----------
// HTTPヘッダに入れるJSONは非ASCII文字を \uXXXX にエスケープする必要がある
const headerJson = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4));
async function dbx(url, init, retry) {
  const token = await accessToken();
  init.headers = Object.assign({}, init.headers, { Authorization: 'Bearer ' + token });
  const r = await fetch(url, init);
  if (r.status === 401 && !retry) { auth.access = null; return dbx(url, init, true); }
  if (r.status === 401) throw signedOut();
  if (!r.ok) {
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    const e = new Error(r.status === 429 ? 'アクセスが集中しています。少し待ってください。' : (j && j.error_summary) || t || r.statusText);
    e.status = r.status; e.summary = (j && j.error_summary) || ''; throw e;
  }
  return r;
}
async function rpc(endpoint, arg) {
  const init = { method: 'POST' };
  if (arg !== null) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(arg); }
  const r = await dbx('https://api.dropboxapi.com/2/' + endpoint, init);
  return r.json().catch(() => ({}));
}
const dropboxBackend = {
  kind: 'dropbox', label: 'Dropbox', refreshMs: 60000,
  async list() {
    let r = await rpc('files/list_folder', { path: ROOT, limit: 2000 });
    const out = r.entries;
    while (r.has_more) { r = await rpc('files/list_folder/continue', { cursor: r.cursor }); out.push(...r.entries); }
    return out.filter((e) => e['.tag'] === 'file' && /\.md$/i.test(e.name))
      .map((e) => ({ name: e.name, rev: e.rev, mtime: Date.parse(e.client_modified || e.server_modified), size: e.size }));
  },
  async download(name) {
    const r = await dbx('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { 'Dropbox-API-Arg': headerJson({ path: pathOf(name) }) } });
    const buf = new Uint8Array(await r.arrayBuffer());
    let rev = null; try { rev = JSON.parse(r.headers.get('dropbox-api-result')).rev; } catch {}
    if (!rev) { const f = files.find((x) => x.name === name); rev = f ? f.rev : (await rpc('files/get_metadata', { path: pathOf(name) })).rev; }
    return Object.assign({ rev }, decodeBuf(buf));
  },
  // mode: 'add'(新規) | 'overwrite'(強制) | {update: rev}(revが一致する場合のみ)
  async upload(name, text, mode, fmt) {
    const r = await dbx('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': headerJson({ path: pathOf(name), mode: mode.update ? { '.tag': 'update', update: mode.update } : mode, autorename: false, mute: true }) },
      body: encodeText(text, fmt),
    });
    const m = await r.json();
    return { rev: m.rev, mtime: Date.parse(m.client_modified || m.server_modified) || Date.now() };
  },
  async move(from, to) {
    const r = await rpc('files/move_v2', { from_path: pathOf(from), to_path: pathOf(to), autorename: false });
    return { name: r.metadata.name, rev: r.metadata.rev };
  },
  remove: (name) => rpc('files/delete_v2', { path: pathOf(name) }),
  async disconnect() { try { await rpc('auth/token/revoke', null); } catch {} auth = null; saveAuth(); },
};

// ---------- 保存先 2: このPCのフォルダ（File System Access API。通信なしで高速） ----------
function localBackend(dir) {
  const revOf = (f) => f.lastModified + '-' + f.size;
  const fileOf = async (name) => { try { return await (await dir.getFileHandle(name)).getFile(); } catch (e) { if (e.name === 'NotFoundError') return null; throw e; } };
  const write = async (name, data) => { const h = await dir.getFileHandle(name, { create: true }); const w = await h.createWritable(); await w.write(data); await w.close(); return h.getFile(); };
  return {
    kind: 'local', label: 'ローカル: ' + dir.name, refreshMs: 10000,
    async list() {
      const out = [];
      for await (const [name, h] of dir.entries()) {
        if (h.kind !== 'file' || !/\.md$/i.test(name)) continue;
        const f = await h.getFile(); out.push({ name, rev: revOf(f), mtime: f.lastModified, size: f.size });
      }
      return out;
    },
    async download(name) {
      const f = await fileOf(name); if (!f) throw new Error('ファイルが見つかりません');
      return Object.assign({ rev: revOf(f) }, decodeBuf(new Uint8Array(await f.arrayBuffer())));
    },
    async upload(name, text, mode, fmt) {
      const old = await fileOf(name);
      if (mode === 'add' && old) throw conflictErr();
      if (mode.update && (!old || revOf(old) !== mode.update)) throw conflictErr();
      const f = await write(name, encodeText(text, fmt));
      return { rev: revOf(f), mtime: f.lastModified };
    },
    async move(from, to) {
      if (from.toLowerCase() !== to.toLowerCase() && (await fileOf(to))) throw conflictErr();
      const h = await dir.getFileHandle(from);
      try { await h.move(to); } catch { await write(to, await (await h.getFile()).arrayBuffer()); await dir.removeEntry(from); }
      return { name: to, rev: revOf(await fileOf(to)) };
    },
    remove: (name) => dir.removeEntry(name),
    async disconnect() { await idb.del('kv', 'dir'); },
  };
}

// ---------- 状態 ----------
let backend = null;
let files = [], cur = null; // cur = {name, rev, dirty, bom, crlf}
const texts = new Map();    // name -> {rev, text, bom, crlf}  本文キャッシュ（検索・一覧の見出し・即時表示用）
let saveTimer = null, saving = null;
const setText = (name, o) => { texts.set(name, o); idb.put('texts', name, o); };
const dropText = (name) => { texts.delete(name); idb.del('texts', name); };
const saveFilesCache = () => lsSet('memue.files', JSON.stringify(files));
const clearCaches = async () => { await idb.clear('texts'); lsSet('memue.files', null); };

const SORTS = {
  'mtime-desc': (a, b) => b.mtime - a.mtime,
  'mtime-asc': (a, b) => a.mtime - b.mtime,
  'name-desc': (a, b) => b.name.localeCompare(a.name, 'ja', { numeric: true }),
  'name-asc': (a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }),
};
let sortKey = SORTS[lsGet('memue.sort')] ? lsGet('memue.sort') : 'mtime-desc';

const editor = MemueEditor($('ed'), {
  onChange() {
    if (!cur) return;
    cur.dirty = true; setStatus('未保存');
    clearTimeout(saveTimer); saveTimer = setTimeout(save, backend.kind === 'local' ? 600 : 1500);
  },
  onSave: () => save(), // Vim の :w
});

function firstLine(text) {
  for (const l of text.split('\n')) { const t = l.replace(/^#+\s*/, '').trim(); if (t && t !== '---') return t.slice(0, 80); }
  return '';
}

// ---------- 起動・保存先の選択 ----------
const canLocal = 'showDirectoryPicker' in window;
async function boot() {
  const q = new URLSearchParams(location.search);
  if (q.has('code') || q.has('error')) {
    history.replaceState(null, '', location.pathname);
    try { if (q.has('error')) throw new Error('接続がキャンセルされました。'); await finishLogin(q.get('code'), q.get('state')); lsSet('memue.backend', 'dropbox'); }
    catch (e) { $('gateErr').textContent = e.message; }
  }
  const kind = lsGet('memue.backend');
  let regrant = null;
  if (kind === 'local' && canLocal) {
    const dir = await idb.get('kv', 'dir');
    if (dir) { if ((await dir.queryPermission({ mode: 'readwrite' })) === 'granted') backend = localBackend(dir); else regrant = dir; }
  } else if (kind === 'dropbox' && auth) backend = dropboxBackend;
  if (backend) return startApp();

  // 保存先の選択画面
  $('gate').hidden = false;
  $('localBtn').hidden = !canLocal;
  if (!CFG.appKey) $('loginBtn').hidden = true;
  if (regrant) {
    $('gateMsg').textContent = 'フォルダ「' + regrant.name + '」へのアクセス許可が必要です。';
    $('regrantBtn').hidden = false;
    $('regrantBtn').onclick = async () => { if ((await regrant.requestPermission({ mode: 'readwrite' })) === 'granted') location.reload(); };
  }
}
$('loginBtn').onclick = async () => {
  try { if (auth) { await clearCaches(); lsSet('memue.backend', 'dropbox'); location.reload(); } else await login(); }
  catch (e) { $('gateErr').textContent = e.message; }
};
$('localBtn').onclick = async () => {
  try {
    const dir = await showDirectoryPicker({ mode: 'readwrite', id: 'memue' });
    await idb.put('kv', 'dir', dir); await clearCaches(); lsSet('memue.backend', 'local'); location.reload();
  } catch (e) { if (e.name !== 'AbortError') $('gateErr').textContent = e.message; }
};
$('switchBtn').onclick = async () => { // 接続は保ったまま、保存先の選択画面に戻る
  if (!(await flush())) return;
  if (cur) cur.dirty = false; lsSet('memue.backend', null); await clearCaches(); location.href = location.pathname;
};
$('logoutBtn').onclick = async () => {
  if (cur && cur.dirty && !(await save()) && !confirm('保存できていない変更があります。破棄して解除しますか？')) return;
  if (!confirm(backend.kind === 'local' ? 'このフォルダとの接続を解除しますか？（ファイルは消えません）' : 'このデバイスと Dropbox の接続を解除しますか？')) return;
  await backend.disconnect(); await clearCaches(); lsSet('memue.backend', null);
  if (cur) cur.dirty = false; location.href = location.pathname;
};

async function startApp() {
  $('app').hidden = false;
  setMode(lsGet('memue.mode') || (innerWidth <= 760 ? 'preview' : 'edit'));
  $('sort').value = sortKey;
  const vimOn = lsGet('memue.vim') ? lsGet('memue.vim') === '1' : matchMedia('(pointer: fine)').matches;
  $('vimChk').checked = vimOn; editor.setVim(vimOn);
  const h = decodeURIComponent(location.hash.slice(1));
  try { files = JSON.parse(lsGet('memue.files') || '[]'); } catch { files = []; }
  for (const [k, v] of await idb.all('texts')) texts.set(k, v);
  const cached = files.length > 0;
  if (cached) { renderList(); if (h && files.some((f) => f.name === h)) openFile(h); else setStatus('更新を確認中…'); }
  const first = loadFiles().then(() => { if (!cur) setStatus(''); if (!cached && h && files.some((f) => f.name === h)) openFile(h); });
  if (!cached) await first; else first.catch((e) => setStatus(navigator.onLine ? e.message : 'オフラインです', true));
  setInterval(() => { if (!document.hidden) loadFiles().catch(() => {}); }, backend.refreshMs);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadFiles().catch(() => {}); });
}
$('vimChk').onchange = () => { editor.setVim($('vimChk').checked); lsSet('memue.vim', $('vimChk').checked ? '1' : '0'); };

// ---------- 一覧・検索 ----------
async function loadFiles() {
  files = await backend.list();
  for (const n of [...texts.keys()]) if (!files.some((f) => f.name === n)) dropText(n);
  saveFilesCache(); renderList(); indexTexts();
  // 開いているメモが他で更新されていたら、未編集の場合に限り読み直す
  if (cur && !cur.dirty && !saving) {
    const f = files.find((x) => x.name === cur.name);
    if (f && f.rev !== cur.rev) { const n = cur.name; cur = null; openFile(n, true); }
  }
}
let indexing = false;
async function indexTexts() { // 未取得・更新済みの本文だけをバックグラウンドで取得（6並列）
  if (indexing) return; indexing = true;
  const todo = files.filter((f) => !(texts.has(f.name) && texts.get(f.name).rev === f.rev));
  let dirtyList = false;
  const worker = async () => {
    for (let f; (f = todo.shift());) {
      try { setText(f.name, await backend.download(f.name)); dirtyList = true; } catch (e) { if (e.status === 429) await new Promise((r) => setTimeout(r, 3000)); }
    }
  };
  const tick = setInterval(() => { if (dirtyList) { dirtyList = false; renderList(); } }, 700);
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  clearInterval(tick); indexing = false; renderList();
}
function fmtDate(ms) {
  const d = new Date(ms), n = new Date(), p = (x) => String(x).padStart(2, '0');
  if (d.toDateString() === n.toDateString()) return p(d.getHours()) + ':' + p(d.getMinutes());
  return (d.getFullYear() === n.getFullYear() ? '' : d.getFullYear() + '/') + (d.getMonth() + 1) + '/' + d.getDate();
}
function renderList() {
  const q = $('q').value.trim().toLowerCase();
  const ul = $('list'), top = ul.scrollTop; ul.textContent = '';
  let n = 0;
  for (const f of [...files].sort(SORTS[sortKey])) {
    const t = texts.get(f.name); let sub = t ? firstLine(t.text) || '（空）' : '';
    if (q) {
      const i = t ? t.text.toLowerCase().indexOf(q) : -1;
      if (i < 0 && !f.name.toLowerCase().includes(q)) continue;
      if (i >= 0) { const s = Math.max(0, i - 30); sub = (s > 0 ? '…' : '') + t.text.slice(s, i + q.length + 50).replace(/\s+/g, ' '); }
    }
    n++;
    const li = el('li', cur && cur.name === f.name ? 'sel' : '');
    li.append(el('span', 't', bare(f.name)));
    const s = el('span', 's'); s.append(el('span', '', sub), el('span', '', fmtDate(f.mtime))); li.append(s);
    li.onclick = () => { openFile(f.name); document.body.classList.remove('menu'); };
    ul.append(li);
  }
  ul.scrollTop = top;
  $('count').textContent = n + ' 件 · ' + backend.label + (indexing ? '（読み込み中…）' : '');
}
$('q').oninput = renderList;
$('sort').onchange = () => { sortKey = $('sort').value; lsSet('memue.sort', sortKey); $('list').scrollTop = 0; renderList(); };

// ---------- 開く・保存 ----------
function setStatus(t, bad) { $('status').textContent = t; $('status').style.color = bad ? 'var(--danger)' : ''; }
function render() {
  let src = editor.get();
  const fm = src.match(/^---\n([\s\S]*?)\n---\n?/); // YAMLフロントマターはコードとして表示
  if (fm) src = '```yaml\n' + fm[1] + '\n```\n' + src.slice(fm[0].length);
  $('pv').innerHTML = DOMPurify.sanitize(marked.parse(src, { gfm: true, breaks: true }));
  for (const a of $('pv').querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
}
async function openFile(name, keepScroll) {
  if (cur && cur.name === name) return;
  if (!(await flush())) return;
  const f = files.find((x) => x.name === name), c = texts.get(name);
  let d = c && f && c.rev === f.rev ? c : null;
  if (!d) {
    setStatus('読み込み中…');
    try { d = await backend.download(name); }
    catch (e) { setStatus(''); alert('開けませんでした: ' + e.message); return loadFiles().catch(() => {}); }
    setText(name, d);
  }
  cur = { name, rev: d.rev, dirty: false, bom: d.bom, crlf: d.crlf };
  editor.set(d.text); $('title').value = bare(name);
  $('title').disabled = $('delBtn').disabled = false;
  $('panes').hidden = false; $('empty').hidden = true;
  if (!keepScroll) $('pv').scrollTop = 0;
  history.replaceState(null, '', '#' + encodeURIComponent(name));
  document.title = bare(name) + ' — Memue';
  setStatus(''); if (isPreview()) render(); else if (matchMedia('(pointer: fine)').matches) editor.focus();
  renderList();
}
function closeFile() {
  cur = null; clearTimeout(saveTimer);
  $('panes').hidden = true; $('empty').hidden = false; $('title').value = ''; $('title').disabled = $('delBtn').disabled = true;
  history.replaceState(null, '', location.pathname); document.title = 'Memue'; setStatus('');
}
// 保存。成功(または保存不要)なら true
async function save(force) {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!cur || !cur.dirty) return true;
  const target = cur, content = editor.get();
  setStatus('保存中…');
  saving = (async () => {
    try {
      const m = await backend.upload(target.name, content, force ? 'overwrite' : { update: target.rev }, target);
      target.rev = m.rev; setText(target.name, { rev: m.rev, text: content, bom: target.bom, crlf: target.crlf });
      const f = files.find((x) => x.name === target.name); if (f) { f.rev = m.rev; f.mtime = m.mtime; saveFilesCache(); }
      if (cur === target && editor.get() === content) { target.dirty = false; setStatus('保存済み'); }
      return true;
    } catch (e) {
      if (isConflict(e)) return 'conflict';
      setStatus('保存失敗: ' + (navigator.onLine || backend.kind === 'local' ? e.message : 'オフラインです'), true);
      clearTimeout(saveTimer); saveTimer = setTimeout(save, 5000); // 少し待って自動で再試行
      return false;
    }
  })();
  const r = await saving; saving = null;
  if (r !== 'conflict') return r;
  if (confirm('このメモは他の場所で変更（または削除）されています。\n\nOK: こちらの内容で上書き\nキャンセル: 何もしない（未保存のまま）')) return save(true);
  setStatus('競合のため未保存', true); return false;
}
async function flush() {
  if (!cur || !cur.dirty) return true;
  if (await save()) return true;
  return confirm('保存できていない変更があります。破棄して移動しますか？');
}
addEventListener('beforeunload', (e) => { if (cur && cur.dirty) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.hidden && cur && cur.dirty) save(); }); // アプリを離れる時に保存

// ---------- 新規・改名・削除 ----------
function validName(n) {
  n = n.trim(); if (!/\.md$/i.test(n)) n += '.md';
  return n.length > 3 && n.length <= 200 && !/[\\/:*?"<>|\x00-\x1f]/.test(n) && !n.startsWith('.') ? n : null;
}
$('newBtn').onclick = async () => {
  if (!(await flush())) return;
  const d = new Date(), p = (x) => String(x).padStart(2, '0');
  const name = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.md`;
  try {
    await backend.upload(name, '', 'add');
    cur = null; await loadFiles(); await openFile(name);
    if (isPreview()) setMode('edit');
    document.body.classList.remove('menu'); editor.focus();
  } catch (e) { alert('作成できませんでした: ' + e.message); }
};
$('title').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.value = bare(cur.name); e.target.blur(); } };
$('title').onchange = async () => {
  if (!cur) return;
  const back = () => { $('title').value = bare(cur.name); };
  const to = validName($('title').value);
  if (!to) { alert('ファイル名に使えない文字が含まれています。'); return back(); }
  if (to === cur.name) return back();
  if (!(await save())) return back();
  try {
    const r = await backend.move(cur.name, to);
    const t = texts.get(cur.name); dropText(cur.name);
    cur.name = r.name; cur.rev = r.rev; if (t) setText(cur.name, Object.assign({}, t, { rev: cur.rev }));
    back(); history.replaceState(null, '', '#' + encodeURIComponent(cur.name)); document.title = bare(cur.name) + ' — Memue';
    await loadFiles();
  } catch (e) { alert(isConflict(e) ? '同名のファイルがあります。' : '名前を変更できませんでした: ' + e.message); back(); }
};
$('delBtn').onclick = async () => {
  if (!cur || !confirm('「' + cur.name + '」を削除しますか？\n（Dropbox の「削除したファイル」から一定期間は復元できます）')) return;
  try { await backend.remove(cur.name); dropText(cur.name); closeFile(); await loadFiles(); }
  catch (e) { alert('削除できませんでした: ' + e.message); }
};

// ---------- 表示モード・キー操作 ----------
const isPreview = () => $('panes').className === 'mode-preview';
function setMode(m) {
  if (m !== 'preview') m = 'edit';
  $('panes').className = 'mode-' + m; lsSet('memue.mode', m);
  $('modeBtn').textContent = m === 'edit' ? '閲覧' : '編集';
  $('modeBtn').title = (m === 'edit' ? '整形して表示' : '編集に戻る') + ' (Ctrl+E)';
  if (m === 'preview') { render(); if (document.activeElement) document.activeElement.blur(); } else if (cur) editor.focus();
}
$('modeBtn').onclick = () => setMode(isPreview() ? 'edit' : 'preview');
$('menuBtn').onclick = () => document.body.classList.toggle('menu');
$('scrim').onclick = () => document.body.classList.remove('menu');
addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 's') { e.preventDefault(); save(); return; }
  if (mod && k === 'e' && cur) { e.preventDefault(); setMode(isPreview() ? 'edit' : 'preview'); return; }
  // 閲覧中は Vim 風に j/k でスクロール、i で編集へ
  if (!cur || !isPreview() || mod || e.altKey || e.isComposing || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const pv = $('pv'), page = pv.clientHeight * 0.85;
  const by = { j: 60, k: -60, d: page / 2, u: -page / 2, ' ': page }[e.key];
  if (by) { e.preventDefault(); pv.scrollBy(0, by); }
  else if (e.key === 'g') { e.preventDefault(); pv.scrollTop = 0; }
  else if (e.key === 'G') { e.preventDefault(); pv.scrollTop = pv.scrollHeight; }
  else if (e.key === 'i') { e.preventDefault(); setMode('edit'); }
});

if ('serviceWorker' in navigator && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) navigator.serviceWorker.register('sw.js').catch(() => {});
boot().catch((e) => { setStatus(e.message, true); if ($('app').hidden) { $('gate').hidden = false; $('gateErr').textContent = e.message; } });
