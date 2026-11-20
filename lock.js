/* lock.js — 앱 잠금 + 기기 저장 데이터 암호화
 * - 민감 항목(기준·시험장, 위치, 체크, 조건, 붙여넣은 원문)은 암호에서 유도한 키로 AES-256-GCM 암호화해 보관
 * - 키 유도: PBKDF2-SHA256 600,000회, 16바이트 솔트. 키는 메모리에만 있고 저장하지 않음
 * - 잠금 해제 후 app.js를 불러옴. window.SECURE 로 동기식 get/set 제공(저장은 비동기 암호화)
 */
(function () {
  'use strict';
  const VAULT = 'nn_vault';
  const SETTINGS = 'nn_lockcfg';          // {autoMin} — 민감하지 않은 설정
  const FAIL = 'nn_lockfail';              // {n, until} — 연속 실패 지연
  const ITER = 600000;
  const SENSITIVE = ['nn_pos', 'nn_mode', 'nn_ref', 'nn_saved2', 'nn_saved', 'nn_point', 'nn_checks', 'nn_paste',
    'nn_altLo', 'nn_altHi', 'nn_terrain', 'nn_win', 'nn_radius', 'nn_unchk'];
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = u8 => btoa(String.fromCharCode(...u8));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const $ = id => document.getElementById(id);

  // ───────── 암호화 기본 기능 (공유 링크에서도 사용) ─────────
  async function deriveKey(pw, salt, iter) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function sealWithKey(key, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function openWithKey(key, box) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
    return dec.decode(pt);
  }
  /** 암호로 문자열 암호화 → URL에 넣기 좋은 base64url 한 줄 (솔트16|IV12|암호문) — 공유 링크용(반복 200,000회) */
  async function encryptString(text, pw) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pw, salt, 200000);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));
    const all = new Uint8Array(28 + ct.length); all.set(salt); all.set(iv, 16); all.set(ct, 28);
    return b64(all).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function decryptString(s, pw) {
    const all = unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    const key = await deriveKey(pw, all.slice(0, 16), 200000);
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(16, 28) }, key, all.slice(28)));
  }
  window.CRYPT = { encryptString, decryptString };

  // ───────── 금고 ─────────
  const readJSON = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  let key = null, salt = null, data = {}, saveTimer = null, dirty = false;

  async function persist() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!key || !dirty) return;
    dirty = false;
    const box = await sealWithKey(key, JSON.stringify(data));
    localStorage.setItem(VAULT, JSON.stringify({ v: 1, iter: ITER, salt: b64(salt), iv: box.iv, ct: box.ct }));
  }
  function schedule() { dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(persist, 300); }

  /** 평문으로 남아 있던 민감 항목을 금고로 옮기고 평문 삭제 */
  function migratePlain() {
    let moved = 0;
    for (const k of SENSITIVE) {
      const v = localStorage.getItem(k);
      if (v == null) continue;
      if (!(k in data)) { try { data[k] = JSON.parse(v); } catch (e) { data[k] = v; } }
      localStorage.removeItem(k); moved++;
    }
    return moved;
  }

  async function createVault(pw) {
    salt = crypto.getRandomValues(new Uint8Array(16));
    key = await deriveKey(pw, salt, ITER);
    data = {};
    migratePlain();
    dirty = true; await persist();
  }
  async function unlockVault(pw) {
    const v = readJSON(VAULT, null);
    salt = unb64(v.salt);
    const k = await deriveKey(pw, salt, v.iter || ITER);
    const txt = await openWithKey(k, v);   // 암호가 틀리면 여기서 예외
    key = k; data = JSON.parse(txt);
    if (migratePlain()) { dirty = true; await persist(); }
  }
  async function changePassword(oldPw, newPw) {
    const v = readJSON(VAULT, null);
    const k = await deriveKey(oldPw, unb64(v.salt), v.iter || ITER);
    await openWithKey(k, v); // 현재 암호 확인
    salt = crypto.getRandomValues(new Uint8Array(16));
    key = await deriveKey(newPw, salt, ITER);
    dirty = true; await persist();
  }
  function wipe() {
    localStorage.removeItem(VAULT); localStorage.removeItem(FAIL);
    SENSITIVE.forEach(k => localStorage.removeItem(k));
  }

  // ───────── 잠금 화면 ─────────
  const css = `
  #lock { position:fixed; inset:0; z-index:5000; background:#0f1419; color:#e6edf3; display:flex; align-items:center; justify-content:center;
    padding:calc(20px + env(safe-area-inset-top)) 20px 20px; font:16px/1.5 -apple-system, system-ui, sans-serif; }
  #lock .box { width:100%; max-width:360px; }
  #lock h2 { margin:0 0 6px; font-size:22px; } #lock p { color:#8b98a5; font-size:14px; margin:6px 0 14px; }
  #lock input { width:100%; min-height:48px; border-radius:10px; border:1px solid #2a333d; background:#1a2129; color:#e6edf3; font-size:18px; padding:0 12px; margin-bottom:10px; }
  #lock button { width:100%; min-height:48px; border-radius:10px; border:0; background:#4da3ff; color:#fff; font-size:17px; font-weight:600; }
  #lock button:disabled { opacity:.5; }
  #lock .link { background:none; color:#8b98a5; font-weight:400; font-size:14px; margin-top:18px; min-height:36px; }
  #lock .err { color:#ff6b6b; min-height:22px; font-size:14px; }
  body.locked > header, body.locked > main, body.locked > #pickRow { display:none !important; }`;
  function screen(html) {
    let el = $('lock');
    if (!el) {
      const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
      el = document.createElement('div'); el.id = 'lock'; document.body.appendChild(el);
    }
    el.innerHTML = `<div class="box">${html}</div>`;
    document.body.classList.add('locked');
    const first = el.querySelector('input'); if (first) setTimeout(() => first.focus(), 50);
    return el;
  }
  const failState = () => readJSON(FAIL, { n: 0, until: 0 });

  function showSetup() {
    const hadPlain = SENSITIVE.some(k => localStorage.getItem(k) != null);
    const el = screen(`<h2>🔒 앱 암호 설정</h2>
      <p>저장한 기준·시험장, 위치 기록, 확인 체크, 조회 조건을 이 암호로 암호화해 이 기기에만 보관합니다.${hadPlain ? ' 기존에 저장된 정보도 암호화로 옮깁니다.' : ''}<br><b style="color:#f5c451">암호를 잊으면 저장 정보를 복구할 수 없습니다.</b></p>
      <form id="lf"><input type="password" id="p1" autocomplete="new-password" placeholder="새 암호 (6자 이상)">
      <input type="password" id="p2" autocomplete="new-password" placeholder="암호 확인">
      <div class="err" id="le"></div><button id="lb">설정하고 시작</button></form>`);
    el.querySelector('#lf').onsubmit = async e => {
      e.preventDefault();
      const a = $('p1').value, b = $('p2').value;
      if (a.length < 6) { $('le').textContent = '6자 이상으로 정해 주세요.'; return; }
      if (a !== b) { $('le').textContent = '두 암호가 다릅니다.'; return; }
      $('lb').disabled = true; $('lb').textContent = '암호화 중…';
      try { await createVault(a); start(); } catch (err) { $('le').textContent = '설정 실패: ' + err.message; $('lb').disabled = false; $('lb').textContent = '설정하고 시작'; }
    };
  }
  function showUnlock(msg) {
    const el = screen(`<h2>🔒 내 주변 NOTAM</h2><p>앱 암호를 입력하세요.</p>
      <form id="lf"><input type="password" id="p1" autocomplete="current-password" placeholder="암호">
      <div class="err" id="le">${msg || ''}</div><button id="lb">잠금 해제</button></form>
      <button class="link" id="lr">암호를 잊었어요 (저장 정보 초기화)</button>`);
    const tick = () => {
      const f = failState(), left = Math.ceil((f.until - Date.now()) / 1000);
      if (left > 0) { $('lb').disabled = true; $('le').textContent = `${f.n}회 틀림 · ${left}초 후 다시 시도`; setTimeout(tick, 1000); }
      else if ($('lb').textContent !== '확인 중…') { $('lb').disabled = false; }
    };
    tick();
    el.querySelector('#lf').onsubmit = async e => {
      e.preventDefault();
      if (failState().until > Date.now()) return;
      $('lb').disabled = true; $('lb').textContent = '확인 중…'; $('le').textContent = '';
      try {
        await unlockVault($('p1').value);
        localStorage.removeItem(FAIL);
        start();
      } catch (err) {
        const f = failState(); f.n++;
        f.until = f.n >= 3 ? Date.now() + Math.min(300, 5 * 2 ** (f.n - 3)) * 1000 : 0; // 3회부터 5초, 10초, 20초 … 최대 5분
        localStorage.setItem(FAIL, JSON.stringify(f));
        $('lb').textContent = '잠금 해제'; $('p1').value = '';
        $('le').textContent = '암호가 맞지 않습니다.'; tick();
      }
    };
    el.querySelector('#lr').onclick = () => {
      if (!confirm('저장한 기준·시험장, 확인 체크, 조회 조건이 모두 지워집니다. 계속할까요?')) return;
      if (!confirm('정말 초기화할까요? 되돌릴 수 없습니다.')) return;
      wipe(); showSetup();
    };
  }

  // ───────── 잠금 해제 후 ─────────
  let hiddenAt = 0;
  function lockNow() { persist().finally(() => location.reload()); }
  function start() {
    window.SECURE = {
      keys: SENSITIVE.slice(),
      has: k => SENSITIVE.includes(k),
      get: (k, d) => (k in data ? data[k] : d),
      set: (k, v) => { data[k] = v; schedule(); },
      lock: lockNow,
      changePassword: async (o, n) => { await changePassword(o, n); },
      getAutoMin: () => readJSON(SETTINGS, { autoMin: 5 }).autoMin,
      setAutoMin: m => localStorage.setItem(SETTINGS, JSON.stringify({ autoMin: m })),
      flush: persist
    };
    const el = $('lock'); if (el) el.remove();
    document.body.classList.remove('locked');
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); persist(); }
      else if (hiddenAt) {
        const m = window.SECURE.getAutoMin();
        if (m > 0 && Date.now() - hiddenAt > m * 60000) lockNow();
      }
    });
    window.addEventListener('pagehide', () => { persist(); });
    const s = document.createElement('script'); s.src = 'app.js'; document.body.appendChild(s);
  }

  // ───────── 시작 ─────────
  document.body.classList.add('locked');
  if (!window.crypto || !crypto.subtle) {
    screen('<h2>⚠︎ 암호화를 쓸 수 없는 환경</h2><p>HTTPS 주소(https://…github.io)로 열어 주세요.</p>');
    return;
  }
  if (readJSON(VAULT, null)) showUnlock(); else showSetup();
})();
