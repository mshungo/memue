// Memue (Dropbox版) — ブラウザから直接 Dropbox API でメモを読み書きする
'use strict';
const CFG = window.MEMUE_CONFIG || {};
const ROOT = (CFG.root || '').replace(/\/+$/, '');
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const pathOf = (name) => ROOT + '/' + name;
const bare = (name) => name.replace(/\.md$/i, '');

// ---------- Dropbox 認証 (OAuth 2 PKCE・シークレット不要) ----------
const LS = 'memue.dbx';
let auth = null;
try { auth = JSON.parse(localStorage.getItem(LS) || 'null'); } catch {}
const saveAuth = () => { try { auth ? localStorage.setItem(LS, JSON.stringify(auth)) : localStorage.removeItem(LS); } catch {} };
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
async function logout() {
  if (cur && cur.dirty && !(await save()) && !confirm('保存できていない変更があります。破棄して解除しますか？')) return;
  if (!confirm('このデバイスと Dropbox の接続を解除しますか？')) return;
  try { await rpc('auth/token/revoke', null); } catch {}
  auth = null; saveAuth(); if (cur) cur.dirty = false; location.reload();
}

// ---------- Dropbox API ----------
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
async function download(name) {
  const r = await dbx('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { 'Dropbox-API-Arg': headerJson({ path: pathOf(name) }) } });
  const buf = new Uint8Array(await r.arrayBuffer());
  let rev = null; try { rev = JSON.parse(r.headers.get('dropbox-api-result')).rev; } catch {}
  if (!rev) rev = (await rpc('files/get_metadata', { path: pathOf(name) })).rev;
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const raw = new TextDecoder('utf-8').decode(buf);
  return { rev, bom, crlf: raw.includes('\r\n'), text: raw.replace(/\r\n/g, '\n') };
}
async function upload(name, text, mode, fmt) {
  let out = text.replace(/\r\n/g, '\n');
  if (fmt && fmt.crlf) out = out.replace(/\n/g, '\r\n'); // 元の改行コード・BOMを維持
  if (fmt && fmt.bom) out = '﻿' + out;
  const r = await dbx('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': headerJson({ path: pathOf(name), mode, autorename: false, mute: true }) },
    body: new TextEncoder().encode(out),
  });
  return r.json();
}
async function listAll() {
  let r = await rpc('files/list_folder', { path: ROOT, limit: 2000 });
  const out = r.entries;
  while (r.has_more) { r = await rpc('files/list_folder/continue', { cursor: r.cursor }); out.push(...r.entries); }
  return out.filter((e) => e['.tag'] === 'file' && /\.md$/i.test(e.name))
    .map((e) => ({ name: e.name, rev: e.rev, mtime: Date.parse(e.server_modified), size: e.size }))
    .sort((a, b) => b.mtime - a.mtime);
}

// ---------- 状態 ----------
let files = [], cur = null; // cur = {name, rev, dirty, bom, crlf}
const texts = new Map();    // name -> {rev, text}  本文キャッシュ（メモリ内のみ。検索と一覧の見出し用）
let saveTimer = null, saving = null;

function firstLine(text) {
  for (const l of text.split('\n')) { const t = l.replace(/^#+\s*/, '').trim(); if (t && t !== '---') return t.slice(0, 80); }
  return '';
}

// ---------- 起動 ----------
async function boot() {
  if (!CFG.appKey) { $('gate').hidden = false; $('gateMsg').textContent = 'config.js に Dropbox の App key が設定されていません。'; $('loginBtn').hidden = true; return; }
  const q = new URLSearchParams(location.search);
  if (q.has('code') || q.has('error')) {
    history.replaceState(null, '', location.pathname);
    try { if (q.has('error')) throw new Error('接続がキャンセルされました。'); await finishLogin(q.get('code'), q.get('state')); }
    catch (e) { $('gateErr').textContent = e.message; }
  }
  if (!auth) { $('gate').hidden = false; return; }
  $('app').hidden = false;
  setMode(localStorage.getItem('memue.mode') || (innerWidth <= 760 ? 'preview' : 'split'));
  await loadFiles();
  const h = decodeURIComponent(location.hash.slice(1));
  if (h && files.some((f) => f.name === h)) openFile(h);
  setInterval(() => { if (!document.hidden) loadFiles().catch(() => {}); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadFiles().catch(() => {}); });
}
$('loginBtn').onclick = () => login().catch((e) => { $('gateErr').textContent = e.message; });
$('logoutBtn').onclick = logout;

// ---------- 一覧・検索 ----------
async function loadFiles() {
  files = await listAll();
  for (const n of [...texts.keys()]) if (!files.some((f) => f.name === n)) texts.delete(n);
  renderList(); indexTexts();
  // 開いているメモが他の端末で更新されていたら、未編集の場合に限り読み直す
  if (cur && !cur.dirty && !saving) {
    const f = files.find((x) => x.name === cur.name);
    if (f && f.rev !== cur.rev) { const n = cur.name; cur = null; openFile(n, true); }
  }
}
let indexing = false;
async function indexTexts() { // 本文をバックグラウンドで取得（4並列）
  if (indexing) return; indexing = true;
  const todo = files.filter((f) => !(texts.has(f.name) && texts.get(f.name).rev === f.rev));
  let dirtyList = false;
  const worker = async () => {
    for (let f; (f = todo.shift());) {
      try { const d = await download(f.name); texts.set(f.name, { rev: d.rev, text: d.text }); dirtyList = true; } catch (e) { if (e.status === 429) await new Promise((r) => setTimeout(r, 3000)); }
    }
  };
  const tick = setInterval(() => { if (dirtyList) { dirtyList = false; renderList(); } }, 700);
  await Promise.all([worker(), worker(), worker(), worker()]);
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
  for (const f of files) {
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
  $('count').textContent = n + ' 件' + (indexing ? '（本文を読み込み中…）' : '');
}
$('q').oninput = renderList;

// ---------- 開く・保存 ----------
function setStatus(t, bad) { $('status').textContent = t; $('status').style.color = bad ? 'var(--danger)' : ''; }
function render() {
  let src = $('ed').value;
  const fm = src.match(/^---\n([\s\S]*?)\n---\n?/); // YAMLフロントマターはコードとして表示
  if (fm) src = '```yaml\n' + fm[1] + '\n```\n' + src.slice(fm[0].length);
  $('pv').innerHTML = DOMPurify.sanitize(marked.parse(src, { gfm: true, breaks: true }));
  for (const a of $('pv').querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
}
async function openFile(name, keepScroll) {
  if (cur && cur.name === name) return;
  if (!(await flush())) return;
  setStatus('読み込み中…');
  let d;
  try { d = await download(name); }
  catch (e) { setStatus(''); alert('開けませんでした: ' + e.message); return loadFiles().catch(() => {}); }
  texts.set(name, { rev: d.rev, text: d.text });
  cur = { name, rev: d.rev, dirty: false, bom: d.bom, crlf: d.crlf };
  $('ed').value = d.text; $('title').value = bare(name);
  $('title').disabled = $('delBtn').disabled = false;
  $('panes').hidden = false; $('empty').hidden = true;
  if (!keepScroll) $('ed').scrollTop = $('pv').scrollTop = 0;
  history.replaceState(null, '', '#' + encodeURIComponent(name));
  document.title = bare(name) + ' — Memue';
  setStatus(''); render(); renderList();
}
function closeFile() {
  cur = null; clearTimeout(saveTimer);
  $('panes').hidden = true; $('empty').hidden = false; $('title').value = ''; $('title').disabled = $('delBtn').disabled = true;
  history.replaceState(null, '', location.pathname); document.title = 'Memue'; setStatus('');
}
$('ed').oninput = () => {
  if (!cur) return;
  cur.dirty = true; setStatus('未保存'); render();
  clearTimeout(saveTimer); saveTimer = setTimeout(save, 1500);
};
// 保存。成功(または保存不要)なら true
async function save(force) {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!cur || !cur.dirty) return true;
  const target = cur, content = $('ed').value;
  setStatus('保存中…');
  saving = (async () => {
    try {
      const m = await upload(target.name, content, force ? 'overwrite' : { '.tag': 'update', update: target.rev }, target);
      target.rev = m.rev; texts.set(target.name, { rev: m.rev, text: content });
      const f = files.find((x) => x.name === target.name); if (f) { f.rev = m.rev; f.mtime = Date.parse(m.server_modified) || Date.now(); }
      if (cur === target && $('ed').value === content) { target.dirty = false; setStatus('保存済み'); }
      return true;
    } catch (e) {
      if (e.status === 409 && /conflict/.test(e.summary)) return 'conflict';
      setStatus('保存失敗: ' + (navigator.onLine ? e.message : 'オフラインです'), true); return false;
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
addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } });
addEventListener('beforeunload', (e) => { if (cur && cur.dirty) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.hidden && cur && cur.dirty) save(); }); // アプリを離れる時に保存
$('ed').onkeydown = (e) => { // Tabでインデント
  if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
  e.preventDefault();
  const t = e.target; t.setRangeText('  ', t.selectionStart, t.selectionEnd, 'end'); t.dispatchEvent(new Event('input'));
};

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
    await upload(name, '', 'add');
    cur = null; await loadFiles(); await openFile(name);
    if ($('panes').className === 'mode-preview') setMode('edit');
    document.body.classList.remove('menu'); $('ed').focus();
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
    const r = await rpc('files/move_v2', { from_path: pathOf(cur.name), to_path: pathOf(to), autorename: false });
    const t = texts.get(cur.name); texts.delete(cur.name);
    cur.name = r.metadata.name; cur.rev = r.metadata.rev; if (t) texts.set(cur.name, { rev: cur.rev, text: t.text });
    back(); history.replaceState(null, '', '#' + encodeURIComponent(cur.name)); document.title = bare(cur.name) + ' — Memue';
    await loadFiles();
  } catch (e) { alert(/conflict/.test(e.summary || '') ? '同名のファイルがあります。' : '名前を変更できませんでした: ' + e.message); back(); }
};
$('delBtn').onclick = async () => {
  if (!cur || !confirm('「' + cur.name + '」を削除しますか？\n（Dropbox の「削除したファイル」から一定期間は復元できます）')) return;
  try { await rpc('files/delete_v2', { path: pathOf(cur.name) }); closeFile(); await loadFiles(); }
  catch (e) { alert('削除できませんでした: ' + e.message); }
};

// ---------- 表示モード・メニュー ----------
function setMode(m) {
  if (!['edit', 'split', 'preview'].includes(m)) m = 'split';
  $('panes').className = 'mode-' + m; try { localStorage.setItem('memue.mode', m); } catch {}
  for (const b of document.querySelectorAll('.modes button')) b.classList.toggle('on', b.dataset.mode === m);
}
for (const b of document.querySelectorAll('.modes button')) b.onclick = () => setMode(b.dataset.mode);
$('menuBtn').onclick = () => document.body.classList.toggle('menu');
$('scrim').onclick = () => document.body.classList.remove('menu');

boot().catch((e) => { setStatus(e.message, true); if ($('app').hidden) { $('gate').hidden = false; $('gateErr').textContent = e.message; } });
