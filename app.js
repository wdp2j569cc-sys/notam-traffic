/* app.js — 내 주변 NOTAM 본체 (lock.js가 잠금 해제 후 불러옴) */
'use strict';
const APP_VER = 'v14';
const VAPID_PUBLIC = 'BAD9VkAR9bCqI_1ssG26vBTq5G4qvh5gfQvUN70rpbKELZG3bid5gG3CsBB01m0A-EpKFjr7HxEpdfzb57w-xno';
const AIM_URL = 'https://aim.koca.go.kr';
const AIP_TYPES = {
  P: { ko: '금지구역', col: '#ff1744' }, R: { ko: '제한구역', col: '#ff6d00' }, D: { ko: '위험구역', col: '#ffd600' },
  MOA: { ko: '군작전구역', col: '#d500f9' }, UA: { ko: '초경량비행장치구역', col: '#00e676' }, CATA: { ko: '민간항공훈련구역', col: '#1de9b6' },
  TMA: { ko: '접근관제구역', col: '#2979ff' }, ROUTE: { ko: '항로', col: '#00b8d4' }
};
const $ = id => document.getElementById(id);
// 민감 항목은 lock.js의 암호화 금고(window.SECURE)로, 나머지(공개 데이터·화면 설정)는 localStorage로
const store = {
  get(k, d) {
    if (window.SECURE && SECURE.has(k)) return SECURE.get(k, d);
    try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
  },
  set(k, v) {
    if (window.SECURE && SECURE.has(k)) { SECURE.set(k, v); return; }
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function dataUrl() {
  const custom = new URLSearchParams(location.search).get('data');
  if (custom) return custom;
  const h = location.hostname, seg = location.pathname.split('/').filter(Boolean)[0];
  if (h.endsWith('.github.io') && seg) return `https://raw.githubusercontent.com/${h.split('.')[0]}/${seg}/notam-data/notams.json`;
  return 'notams.json';
}

// ───────── 상태 ─────────
const state = {
  pos: store.get('nn_pos', null),
  mode: store.get('nn_mode', 'gps'),            // 'gps' | 'ref'
  ref: store.get('nn_ref', null),               // {kind, pts:[{lat,lon}], name}
  saved: store.get('nn_saved2', null),
  radius: store.get('nn_radius', 25),
  win: store.get('nn_win', { h: 0 }),           // {h:0|6|24|72} 또는 {h:'c', from, to}
  altLo: store.get('nn_altLo', ''), altHi: store.get('nn_altHi', ''), terrain: store.get('nn_terrain', 1000),
  data: store.get('nn_data', null),
  pasted: store.get('nn_paste', ''),
  baseline: store.get('nn_base', null),         // {t, raws}
  checks: store.get('nn_checks', {}),
  onlyUnchecked: store.get('nn_unchk', false),
  showMap: store.get('nn_map', true),
  op: store.get('nn_op', false), night: store.get('nn_night', false),
  fetchErr: null, picking: null, kindSel: 'point'
};
// 이전 버전 지정 지점·저장 지점 이전
if (!state.saved) {
  state.saved = (store.get('nn_saved', []) || []).map(p => ({ kind: 'point', pts: [{ lat: p.lat, lon: p.lon }], name: p.name }));
  store.set('nn_saved2', state.saved);
}
if (!state.ref && store.get('nn_point', null)) {
  const p = store.get('nn_point'); state.ref = { kind: 'point', pts: [{ lat: p.lat, lon: p.lon }], name: p.name || '지정 지점' };
}
if (state.mode === 'point') state.mode = 'ref';

// ───────── 시간 표기 ─────────
const pad = n => String(n).padStart(2, '0');
function kstStr(ms, withDate = true) {
  const d = new Date(ms + 9 * 3600e3);
  return (withDate ? `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ` : '') + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function zStr(ms, withDate = true) {
  const d = new Date(ms);
  return (withDate ? pad(d.getUTCDate()) + '/' : '') + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + 'Z';
}
const both = ms => `${kstStr(ms)} KST <span class="small">(${zStr(ms)})</span>`;
function span(a, b) {
  const sameDay = kstStr(a).slice(0, 5) === kstStr(b).slice(0, 5);
  return `${kstStr(a)}–${sameDay ? kstStr(b, false) : kstStr(b)} KST <span class="small">(${zStr(a)}–${zStr(b, !sameDay)})</span>`;
}
function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return '방금'; if (m < 60) return m + '분 전';
  if (m < 1440) return Math.floor(m / 60) + '시간 전'; return Math.floor(m / 1440) + '일 전';
}
const toLocalInput = ms => { const d = new Date(ms + 9 * 3600e3); return d.toISOString().slice(0, 16); };
const fromLocalInput = v => { const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) - 9 * 3600e3 : null; };

/** 조회 시간창 [from, to] (ms) */
function windowRange() {
  const now = Date.now();
  if (state.win.h === 'c' && state.win.from && state.win.to && state.win.to > state.win.from) return [state.win.from, state.win.to];
  const h = state.win.h === 'c' ? 0 : state.win.h;
  return [now, now + Math.max(h * 3600e3, 60e3)];
}

// ───────── 기준 형상 ─────────
const fmtLL = p => `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
const KIND_KO = { point: '지점', area: '구역', route: '경로' };
function refShape() {
  if (state.mode === 'ref' && state.ref && state.ref.pts.length) return Object.assign({}, state.ref, { buffer: state.radius });
  if (state.pos) return { kind: 'point', pts: [{ lat: state.pos.lat, lon: state.pos.lon }], name: '내 위치', buffer: state.radius };
  return null;
}
function refLabel() {
  const r = refShape(); if (!r) return '';
  if (state.mode !== 'ref') return `📍 내 위치 ${fmtLL(r.pts[0])}${state.pos ? ' (' + ago(state.pos.t) + ')' : ''}`;
  return `📌 <b>${esc(r.name || KIND_KO[r.kind])}</b> · ${KIND_KO[r.kind]}${r.kind === 'point' ? ' ' + fmtLL(r.pts[0]) : ' ' + r.pts.length + '점'}`;
}

// ───────── 표시 보조 ─────────
const DIRS = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
const dirName = deg => DIRS[Math.round(deg / 45) % 8];
function colorOf(x) {
  if (x.rel && x.rel.basis === 'inside') return '#ff4d4d';
  const q = x.n.qcode || '';
  if (q[1] === 'R') return '#ff9f43';
  if (q[1] === 'W') return '#f5c451';
  return '#4da3ff';
}
const pad3 = v => String(v).padStart(3, '0');
function altText(x) {
  const n = x.n;
  if (n.lower || n.upper) return `${n.lower || '?'} ~ ${n.upper || '?'}`;
  if (n.lowerFL != null && n.upperFL != null) return `FL${pad3(n.lowerFL)} ~ FL${pad3(n.upperFL)}`;
  return '';
}
function altFilter() {
  const lo = state.altLo === '' || !isFinite(+state.altLo) ? -Infinity : +state.altLo;
  const hi = state.altHi === '' || !isFinite(+state.altHi) ? Infinity : +state.altHi;
  return { lo, hi };
}

// ───────── 데이터 결합 ─────────
let parsedCache = { src: null, list: [] };
function allNotams() {
  const src = (state.data ? state.data.updated : '') + '|' + state.pasted;
  if (parsedCache.src === src) return parsedCache.list;
  const raws = [];
  if (state.data && state.data.notams) raws.push(...state.data.notams);
  if (state.pasted.trim()) raws.push(...NOTAM.splitNotams(state.pasted));
  parsedCache = { src, list: raws.map(r => { try { return NOTAM.parseNotam(r); } catch (e) { return null; } }).filter(Boolean) };
  return parsedCache.list;
}
let baseCache = { t: null };
function baselineInfo() {
  if (!state.baseline) return null;
  if (baseCache.t !== state.baseline.t) {
    const list = state.baseline.raws.map(r => { try { return NOTAM.parseNotam(r); } catch (e) { return null; } }).filter(Boolean);
    baseCache = { t: state.baseline.t, list, keys: new Set(list.map(NEAR.keyOf)), ids: new Set(list.map(n => n.id).filter(Boolean)) };
  }
  return baseCache;
}
function setBaseline() {
  state.baseline = { t: new Date().toISOString(), raws: state.data ? state.data.notams.slice() : [] };
  store.set('nn_base', state.baseline);
}

// ───────── 렌더링 ─────────
let keyMap = {};
function card(x, key) {
  const n = x.n, now = Date.now(), a = x.rel;
  keyMap[key] = x.key;
  const inside = a.basis === 'inside';
  const ns = NEAR.nowState(n, now);
  let b = '';
  if (x.isNew) b += `<span class="badge b-new">${x.changed ? '변경' : 'NEW'}</span>`;
  if (inside) b += `<span class="badge b-in">${state.mode !== 'ref' ? '현재 위치 포함' : state.ref.kind === 'point' ? '기준점 포함' : '기준과 겹침'}</span>`;
  if (!ns.known) b += '<span class="badge b-unk">시간대 확인 필요</span>';
  else if (ns.active) b += `<span class="badge b-act">운용 중${ns.until === Infinity ? ' (PERM)' : ' ~' + kstStr(ns.until, ns.until - now > 20 * 3600e3)}</span>`;
  else if (ns.next) b += `<span class="badge b-soon">다음 ${kstStr(ns.next[0])}</span>`;
  else b += '<span class="badge b-off">7일 내 운용 없음</span>';
  if (x.alt.agl) b += '<span class="badge b-agl">AGL</span>';
  let dist = '';
  if (inside) dist = '겹침';
  else if (a.basis === 'qcircle' && a.distNm === 0) dist = 'Q원 범위 안';
  else if (a.distNm != null) {
    const r = refShape(), c = a.center, rp = r.kind === 'point' ? r.pts[0] : null;
    dist = `${a.distNm < 10 ? a.distNm.toFixed(1) : Math.round(a.distNm)} NM` +
      (c && rp ? ' ' + dirName(NOTAM.bearingDeg(rp.lat, rp.lon, c[0], c[1])) : '') + (a.basis === 'qcircle' ? ' (Q원)' : '');
  }
  const B = n.start ? n.start.getTime() : null, C = n.end ? n.end.getTime() : null;
  const valid = `${B ? both(B) : '?'} ~ ${n.perm ? 'PERM' : C ? both(C) : '?'}${n.est ? ' EST' : ''}`;
  let sched = '';
  if (n.schedule) {
    sched = `<br>⏱ ${esc(n.schedule.replace(/\s+/g, ' '))}`;
    if (x.intervals && x.intervals.length) {
      const shown = x.intervals.slice(0, 3).map(([s, e]) => span(s, e)).join('<br>&nbsp;&nbsp;&nbsp;');
      sched += `<br>▶ 조회 시간 내 운용: ${shown}${x.intervals.length > 3 ? ` 외 ${x.intervals.length - 3}회` : ''}`;
    } else if (x.intervals) sched += '<br>▶ 조회 시간 내 운용 없음';
    else sched += '<br><span class="warn">▶ 운용 시간 형식을 자동 해석하지 못함 — 원문 확인</span>';
  }
  const alt = altText(x);
  const text = n.text || n.raw, long = text.length > 160, done = !!state.checks[x.key];
  return `<div class="card${inside ? ' inside' : ''}${done ? ' done' : ''}" id="c-${key}">
    <div class="top" onclick="focusMap('${key}')"><span class="cat"><span class="sw" style="background:${colorOf(x)}"></span>${esc(NEAR.category(n))}</span><span class="dist">${esc(dist)}</span></div>
    <div class="meta">${b}${esc(n.id || '')} ${esc((n.locations || []).join(' '))}</div>
    <div class="meta">🕒 ${valid}${sched}${alt ? `<br>↕ <b>${esc(alt)}</b>` : ''}</div>
    <div class="txt${long && !state.printing ? ' clip' : ''}" onclick="this.classList.remove('clip')">${esc(text)}</div>
    <div class="foot"><button class="${done ? 'ok' : ''}" onclick="toggleCheck('${key}')">${done ? '✔ 확인함' : '☐ 확인'}</button></div>
  </div>`;
}

function render() {
  const [from, to] = windowRange();
  const now = Date.now();
  keyMap = {};
  const st = [];
  if (state.data) st.push(`데이터 ${ago(state.data.updated)} · ${state.data.notams.length}건`);
  if (state.fetchErr) st.push(`<span class="warn">갱신 실패(${esc(state.fetchErr)})${state.data ? ' — 저장된 데이터 표시' : ''}</span>`);
  const rl = refLabel(); if (rl) st.push(rl);
  st.push(`시간 ${span(from, to)}`);
  $('status').innerHTML = st.join(' · ');
  renderFresh();
  renderWinWarn(from, to);
  renderCondSum();

  const ref = refShape();
  if (!ref) {
    drawMap([]); $('summary').textContent = '';
    $('list').innerHTML = '<div class="empty">📍 버튼을 눌러 위치 사용을 허용하거나, 📌 기준에서 지점·구역·경로를 지정하세요.</div>';
    hideSections(); return;
  }
  const list = allNotams();
  if (!list.length) {
    drawMap([]); $('summary').textContent = '';
    $('list').innerHTML = `<div class="empty">NOTAM 데이터가 없습니다.<br>${state.fetchErr ? '자동 수집 데이터를 받지 못했습니다. 아래에 원문을 붙여넣을 수 있습니다.' : '불러오는 중…'}</div>`;
    hideSections(); return;
  }
  const af = altFilter();
  const res = NEAR.evaluate(list, { ref, from, to, altLo: af.lo, altHi: af.hi, terrainFt: +state.terrain || 0 });
  const base = baselineInfo();
  for (const x of res) {
    x.isNew = !!(base && !base.keys.has(x.key));
    x.changed = x.isNew && x.n.type === 'NOTAMR' && !!x.n.refId && base.ids.has(x.n.refId);
  }
  const wide = res.filter(x => x.rel.basis === 'wide');
  const local = res.filter(x => x.rel.basis !== 'wide');
  const altOut = local.filter(x => !x.altOk);
  const noWin = local.filter(x => x.altOk && x.inWindow === false);
  let main = local.filter(x => x.altOk && x.inWindow !== false);
  if (state.op) main = main.filter(x => { const s = NEAR.nowState(x.n, now); return !s.known || s.active || (s.next && s.next[0] - now < 3 * 3600e3); });
  const unchecked = main.filter(x => !state.checks[x.key]).length;
  const shown = state.onlyUnchecked ? main.filter(x => !state.checks[x.key]) : main;
  const newCnt = main.filter(x => x.isNew).length;

  $('summary').innerHTML = `표시 <b>${shown.length}</b>건 · 확인 <b>${main.length - unchecked}/${main.length}</b>` +
    (newCnt ? ` · <span style="color:#b388ff">신규·변경 <b>${newCnt}</b></span>` : '') +
    (base ? ` <span class="small">(기준 ${kstStr(new Date(base.t).getTime())} KST)</span>` : '') +
    (state.onlyUnchecked ? ' · <span class="warn">미확인만</span>' : '') + (state.op ? ' · <b>수행 모드</b>(운용 중·3시간 내 시작)' : '');
  $('list').innerHTML = shown.length ? shown.map(x => card(x, 'm' + main.indexOf(x))).join('')
    : `<div class="empty">${main.length ? '모든 항목을 확인했습니다.' : `조건(${KIND_KO[ref.kind]} ±${state.radius} NM, 선택 시간, 고도)에 맞는 NOTAM이 없습니다.`}<br><span class="small">수집 대상 ${state.data ? (state.data.locations || []).length : 0}개 위치지시자 기준</span></div>`;
  section('noWin', noWin, '선택 시간대에 운용하지 않는 NOTAM (D항목 기준)', 'n');
  section('altOut', altOut, '시험 고도 범위 밖 NOTAM', 'a');
  section('wide', wide, '광역 NOTAM (FIR·레이더 범위 등)', 'w');
  renderAip(ref, af);
  renderGone(base, ref, from, to, af, list);
  drawMap(main.map((x, i) => ({ x, key: 'm' + i })));
  $('baseBtn').textContent = newCnt ? `🆕 기준 갱신 (신규 ${newCnt})` : '🆕 기준 갱신';
}
function section(id, arr, title, p) {
  $(id + 'Box').hidden = !arr.length;
  $(id + 'Sum').textContent = `${title} ${arr.length}건`;
  $(id + 'Title').textContent = `${title} ${arr.length}건`;
  $(id).innerHTML = arr.map((x, i) => card(x, p + i)).join('');
}
function hideSections() { ['noWin', 'altOut', 'wide', 'gone'].forEach(id => $(id + 'Box').hidden = true); }
function renderGone(base, ref, from, to, af, list) {
  if (!base) { $('goneBox').hidden = true; return; }
  const cur = new Set(list.map(NEAR.keyOf));
  const gone = NEAR.evaluate(base.list.filter(n => !cur.has(NEAR.keyOf(n))), { ref, from, to, altLo: af.lo, altHi: af.hi, terrainFt: +state.terrain || 0 })
    .filter(x => x.rel.basis !== 'wide');
  $('goneBox').hidden = !gone.length;
  const t = `기준 이후 사라진 NOTAM (취소·대체·만료) ${gone.length}건`;
  $('goneSum').textContent = t; $('goneTitle').textContent = t;
  $('gone').innerHTML = gone.map((x, i) => card(x, 'g' + i)).join('');
}
function renderFresh() {
  const el = $('fresh');
  if (!state.data) { el.className = ''; return; }
  const m = (Date.now() - new Date(state.data.updated).getTime()) / 60000;
  const aim = `<a href="${AIM_URL}" target="_blank" rel="noopener">AIM Korea</a>`;
  if (m > 90) { el.className = 'lv2'; el.innerHTML = `⚠︎ 데이터가 ${ago(state.data.updated)} 것입니다. 이후 발행·취소분이 빠져 있을 수 있습니다. 비행 전 ${aim}에서 최종 확인하세요.`; }
  else if (m > 35) { el.className = 'lv1'; el.innerHTML = `데이터 ${ago(state.data.updated)} · 자동 갱신이 지연되고 있습니다. 비행 전 ${aim} 최종 확인.`; }
  else if (state.op) { el.className = 'lv1'; el.innerHTML = `수행 전 ${aim} 최종 확인 · 데이터 ${ago(state.data.updated)}`; }
  else el.className = '';
}
function renderWinWarn(from, to) {
  const now = Date.now(), w = [];
  if (from > now + 7 * 864e5) w.push('⚠︎ NOTAM은 보통 비행 1~2주 전에 발행됩니다. 선택한 시간의 NOTAM은 아직 발행되지 않았을 수 있습니다. 가까워지면 다시 확인하세요.');
  if (to < now) w.push('⚠︎ 지난 시간입니다. 수집 데이터에는 현재 유효한 NOTAM만 있어 당시 NOTAM이 빠져 있을 수 있습니다.');
  $('winWarn').innerHTML = w.join('<br>');
  if (state.win.h === 'c') $('custZ').textContent = `UTC ${zStr(from)} ~ ${zStr(to)}`;
}
function renderCondSum() {
  const af = altFilter(), parts = [];
  if (af.lo !== -Infinity || af.hi !== Infinity) parts.push(`${af.lo === -Infinity ? 'SFC' : af.lo + 'ft'}~${af.hi === Infinity ? 'UNL' : af.hi + 'ft'}`);
  if (state.onlyUnchecked) parts.push('미확인만');
  $('condSum').textContent = parts.join(' · ');
}

// ───────── 확인 체크 ─────────
function toggleCheck(cardKey) {
  const key = keyMap[cardKey]; if (!key) return;
  if (state.checks[key]) delete state.checks[key]; else state.checks[key] = Date.now();
  store.set('nn_checks', state.checks); render();
}

// ───────── 지도 ─────────
let map = null, layers = null, shapes = {}, pickLayer = null;
function initMap() {
  if (map || typeof L === 'undefined') return;
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([36.5, 127.8], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 16, crossOrigin: true, attribution: '© OpenStreetMap' }).addTo(map);
  map.createPane('aip'); map.getPane('aip').style.zIndex = 350;
  layers = { ref: L.layerGroup().addTo(map), notam: L.layerGroup().addTo(map) };
  pickLayer = L.layerGroup().addTo(map);
  initAipLayers();
  map.on('zoomend', () => $('map').classList.toggle('zlow', map.getZoom() < 9));
  $('map').classList.toggle('zlow', map.getZoom() < 9);
  map.on('click', e => {
    if (!state.picking) return;
    state.picking.push({ lat: +e.latlng.lat.toFixed(5), lon: +e.latlng.lng.toFixed(5) });
    if (state.kindSel === 'point') { finishPick(); return; }
    drawPick();
  });
}
function applyMapVisibility() {
  const el = $('map');
  if (typeof L === 'undefined') {
    el.classList.remove('hide');
    el.innerHTML = '<div class="empty">지도 라이브러리를 불러오지 못했습니다.<br>새로고침하거나, 설정 › Safari › 콘텐츠 차단기를 확인하세요.</div>';
    return;
  }
  el.classList.toggle('hide', !state.showMap);
  $('mapBtn').style.opacity = state.showMap ? 1 : .5;
  if (state.showMap) { initMap(); setTimeout(() => map && map.invalidateSize(), 50); }
}
function popupHtml(x, key) {
  const n = x.n, B = n.start ? n.start.getTime() : null, C = n.end ? n.end.getTime() : null;
  const alt = altText(x);
  return `<b>${esc(NEAR.category(n))}</b> ${esc(n.id || '')}<br>${B ? kstStr(B) : '?'} ~ ${n.perm ? 'PERM' : C ? kstStr(C) : '?'} KST` +
    (alt ? `<br>↕ ${esc(alt)}` : '') + (n.schedule ? `<br>⏱ ${esc(n.schedule.slice(0, 60))}` : '') +
    `<br>${esc((n.text || '').slice(0, 90))}${(n.text || '').length > 90 ? '…' : ''}` +
    `<br><button onclick="showCard('${key}')">목록에서 보기</button>`;
}
function drawRef(group, r) {
  const ll = r.pts.map(p => [p.lat, p.lon]);
  if (r.kind === 'point') {
    if (r.buffer) L.circle(ll[0], { radius: r.buffer * 1852, color: '#4da3ff', weight: 1.5, fill: false, dashArray: '6 6', interactive: false }).addTo(group);
    if (state.mode === 'ref') L.circleMarker(ll[0], { radius: 8, color: '#fff', weight: 2, fillColor: '#ff4d4d', fillOpacity: 1 }).bindPopup(esc(r.name || '기준점')).addTo(group);
    return;
  }
  if (r.kind === 'area') L.polygon(ll, { color: '#e040fb', weight: 2.5, fillOpacity: .08 }).bindPopup(esc(r.name || '기준 구역')).addTo(group);
  else {
    L.polyline(ll, { color: '#e040fb', weight: 3 }).bindPopup(esc(r.name || '기준 경로')).addTo(group);
    ll.forEach(p => L.circleMarker(p, { radius: 4, color: '#e040fb', fillOpacity: 1 }).addTo(group));
  }
  if (r.buffer) ll.forEach(p => L.circle(p, { radius: r.buffer * 1852, color: '#e040fb', weight: 1, fill: false, dashArray: '3 6', interactive: false }).addTo(group));
}
function drawMap(items) {
  if (!state.showMap || typeof L === 'undefined') return;
  initMap();
  layers.ref.clearLayers(); layers.notam.clearLayers(); shapes = {};
  const r = refShape();
  if (state.pos) L.circleMarker([state.pos.lat, state.pos.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#1e88ff', fillOpacity: 1 }).bindPopup('현재 위치(GPS)').addTo(layers.ref);
  if (!r) return;
  drawRef(layers.ref, r);
  const size = n => n.geoms.length ? (n.geoms[0].radiusNm || (n.geoms[0].pts ? 5 : 0)) : (n.q ? n.q.radiusNm || 0 : 0);
  items.slice().sort((a, b) => size(b.x.n) - size(a.x.n)).forEach(({ x, key }) => {
    const n = x.n, col = colorOf(x), grp = [];
    for (const g of n.geoms) {
      if (g.kind === 'polygon') grp.push(L.polygon(g.pts, { color: col, weight: 2, fillOpacity: .18 }));
      else if (g.kind === 'circle') grp.push(L.circle(g.center, { radius: g.radiusNm * 1852, color: col, weight: 2, fillOpacity: .18 }));
      else if (g.kind === 'point') grp.push(L.circleMarker(g.center, { radius: 6, color: col, fillOpacity: .7 }));
    }
    if (!grp.length && n.q) grp.push(L.circle([n.q.lat, n.q.lon], { radius: Math.max(n.q.radiusNm, 0.5) * 1852, color: col, weight: 1.5, dashArray: '4 5', fillOpacity: .06 }));
    if (!grp.length) return;
    shapes[key] = L.featureGroup(grp).bindPopup(popupHtml(x, key)).addTo(layers.notam);
  });
  const sig = JSON.stringify(r.pts) + '|' + state.radius;
  if (drawMap.fitted !== sig) {
    if (r.kind === 'point') map.fitBounds(L.latLng(r.pts[0].lat, r.pts[0].lon).toBounds(Math.max(state.radius, 2) * 1852 * 2), { padding: [10, 10] });
    else map.fitBounds(L.latLngBounds(r.pts.map(p => [p.lat, p.lon])).pad(0.15), { padding: [10, 10] });
    drawMap.fitted = sig;
  }
}
function focusMap(key) {
  const fg = shapes[key];
  if (!fg || !map) return;
  if (!state.showMap) { state.showMap = true; store.set('nn_map', true); applyMapVisibility(); render(); }
  $('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
  map.closePopup();
  map.once('moveend', () => fg.openPopup());
  map.fitBounds(fg.getBounds(), { paddingTopLeft: [20, 150], paddingBottomRight: [20, 20], maxZoom: 13, animate: false });
}
function showCard(key) {
  const el = $('c-' + key); if (!el) return;
  document.querySelectorAll('.card.focus').forEach(c => c.classList.remove('focus'));
  el.classList.add('focus');
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ───────── 기준 지정 ─────────
const REF_HINT = {
  point: '한 지점: 36.514, 127.247 · 363406N1273157E · RKTU',
  area: '구역 꼭짓점(3개 이상), 한 줄에 하나 또는 NOTAM식 나열:\n363000N1271000E 363000N1273000E 362000N1273000E',
  route: '경로 지점(2개 이상), 한 줄에 하나 또는 "RKTU - 363000N1271000E - RKSI"'
};
function setKind(k) {
  state.kindSel = k;
  document.querySelectorAll('#kind button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
  $('refIn').placeholder = REF_HINT[k];
  $('refMsg').textContent = k === 'point' ? '반경은 상단 NM 선택값을 씁니다.' : `상단 NM 선택값은 ${k === 'area' ? '구역' : '경로'} 둘레 여유폭(버퍼)으로 씁니다.`;
}
const refToText = r => r.pts.map(fmtLL).join('\n');
function setRef(r) {
  state.ref = r; state.mode = 'ref';
  store.set('nn_ref', r); store.set('nn_mode', 'ref');
  $('refPanel').hidden = true;
  drawMap.fitted = null; updateModeUi(); render();
}
function updateModeUi() {
  $('locBtn').classList.toggle('main', state.mode === 'gps');
  $('refBtn').classList.toggle('main', state.mode === 'ref');
}
function startPick() {
  state.picking = [];
  if (pickLayer) pickLayer.clearLayers();
  if (!state.showMap) { state.showMap = true; store.set('nn_map', true); applyMapVisibility(); render(); }
  if (map) map.closePopup();
  $('map').classList.add('picking');
  $('pickRow').hidden = false;
  $('pickUndo').hidden = $('pickDone').hidden = state.kindSel === 'point';
  $('pickBtn').classList.add('on2'); $('pickBtn').textContent = '👆 지도를 누르세요 (취소)';
  $('pickInfo').textContent = state.kindSel === 'point' ? '지도에서 한 점을 누르세요' : state.kindSel === 'area' ? '꼭짓점을 차례로 누르세요 (3개 이상)' : '경로 지점을 차례로 누르세요 (2개 이상)';
  document.querySelector('main').style.paddingBottom = '90px';
  $('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function stopPick() {
  state.picking = null; if (pickLayer) pickLayer.clearLayers();
  $('map').classList.remove('picking'); $('pickRow').hidden = true; document.querySelector('main').style.paddingBottom = '';
  $('pickBtn').classList.remove('on2'); $('pickBtn').textContent = '👆 지도에서 찍기';
}
function drawPick() {
  pickLayer.clearLayers();
  const ll = state.picking.map(p => [p.lat, p.lon]);
  if (ll.length > 1) (state.kindSel === 'area' ? L.polygon : L.polyline)(ll, { color: '#ffd600', weight: 3, dashArray: '6 4' }).addTo(pickLayer);
  ll.forEach(p => L.circleMarker(p, { radius: 5, color: '#ffd600', fillOpacity: 1 }).addTo(pickLayer));
  $('pickInfo').textContent = `${state.picking.length}점 선택됨`;
}
function finishPick() {
  const pts = state.picking || [], k = state.kindSel;
  const need = k === 'area' ? 3 : k === 'route' ? 2 : 1;
  if (pts.length < need) { $('pickInfo').textContent = `${need}점 이상 필요합니다`; return; }
  stopPick();
  setRef({ kind: k, pts, name: $('refName').value.trim() || (k === 'point' ? '지도 지점' : k === 'area' ? '지도 구역' : '지도 경로') });
}
function renderSaved() {
  $('savedList').innerHTML = state.saved.map((r, i) =>
    `<span class="chip"><button onclick="useSaved(${i})">${r.kind === 'point' ? '📌' : r.kind === 'area' ? '⬠' : '〰'} ${esc(r.name)}</button><button class="x" onclick="delSaved(${i})" aria-label="삭제">✕</button></span>`).join('');
}
function useSaved(i) { setRef(state.saved[i]); }
function delSaved(i) { if (confirm(`'${state.saved[i].name}'을(를) 지울까요?`)) { state.saved.splice(i, 1); store.set('nn_saved2', state.saved); renderSaved(); } }

// ───────── 공유 링크 ─────────
function shareUrl() {
  const r = refShape(), [from, to] = windowRange(), q = new URLSearchParams();
  if (r) { q.set('k', r.kind); q.set('p', r.pts.map(p => p.lat.toFixed(5) + ',' + p.lon.toFixed(5)).join(';')); if (r.name) q.set('n', r.name); }
  q.set('b', state.radius);
  if (state.win.h === 'c') { q.set('f', Math.round(from / 6e4)); q.set('t', Math.round(to / 6e4)); } else q.set('h', state.win.h);
  if (state.altLo !== '') q.set('lo', state.altLo);
  if (state.altHi !== '') q.set('hi', state.altHi);
  return location.origin + location.pathname + '#' + q.toString();
}
async function applyEncryptedHash() {
  const m = location.hash.match(/^#e=([\w-]+)$/);
  if (!m || !window.CRYPT) return;
  history.replaceState(null, '', location.pathname + location.search);
  for (let i = 0; i < 3; i++) {
    const pw = prompt(i ? '암호가 맞지 않습니다. 다시 입력하세요' : '암호가 걸린 공유 링크입니다. 링크 암호를 입력하세요');
    if (!pw) return;
    try {
      const q = await CRYPT.decryptString(m[1], pw);
      applyHash('#' + q); drawMap.fitted = null; syncControls(); updateModeUi(); render(); return;
    } catch (e) { /* 다시 시도 */ }
  }
  alert('링크를 열지 못했습니다.');
}
function applyHash(hash) {
  hash = hash || location.hash;
  if (!hash || hash.length < 3 || /^#e=/.test(hash)) return false;
  const q = new URLSearchParams(hash.slice(1));
  const pts = (q.get('p') || '').split(';').map(s => s.split(',').map(Number)).filter(a => a.length === 2 && a.every(isFinite)).map(([lat, lon]) => ({ lat, lon }));
  const k = ['point', 'area', 'route'].includes(q.get('k')) ? q.get('k') : 'point';
  if (pts.length) { state.ref = { kind: k, pts, name: q.get('n') || '공유된 ' + KIND_KO[k] }; state.mode = 'ref'; store.set('nn_ref', state.ref); store.set('nn_mode', 'ref'); }
  if (q.has('b') && isFinite(+q.get('b'))) { state.radius = +q.get('b'); store.set('nn_radius', state.radius); }
  if (q.has('f') && q.has('t')) state.win = { h: 'c', from: +q.get('f') * 6e4, to: +q.get('t') * 6e4 };
  else if (q.has('h')) state.win = { h: +q.get('h') || 0 };
  store.set('nn_win', state.win);
  if (q.has('lo')) { state.altLo = q.get('lo'); store.set('nn_altLo', state.altLo); }
  if (q.has('hi')) { state.altHi = q.get('hi'); store.set('nn_altHi', state.altHi); }
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

// ───────── 브리핑 인쇄 ─────────
function printBrief() {
  const [from, to] = windowRange(), r = refShape(), af = altFilter(), d = state.data;
  $('printHead').innerHTML = `<h2>NOTAM 브리핑 — ${esc(r ? (r.name || KIND_KO[r.kind]) : '')}</h2>
    기준: ${r ? KIND_KO[r.kind] + ' ' + r.pts.map(fmtLL).join(' / ') : '-'} · 여유폭/반경 ${state.radius} NM<br>
    시간: ${span(from, to)}<br>
    고도: ${af.lo === -Infinity ? 'SFC' : af.lo + ' ft'} ~ ${af.hi === Infinity ? 'UNL' : af.hi + ' ft'} AMSL (AGL은 지형 ${esc(state.terrain)} ft 가정)<br>
    데이터: ${d ? esc(d.source || '') + ' · ' + both(new Date(d.updated).getTime()) : '-'} · 출력 ${both(Date.now())}<br>
    <b>참고용 — 공식 브리핑(AIM Korea)으로 최종 확인할 것.</b>`;
  const closed = [...document.querySelectorAll('main details')].filter(x => !x.open);
  closed.forEach(x => x.open = true);
  state.printing = true; render();
  const after = () => { state.printing = false; closed.forEach(x => x.open = false); render(); window.removeEventListener('afterprint', after); };
  window.addEventListener('afterprint', after);
  setTimeout(() => { if (map) map.invalidateSize(); window.print(); }, 300);
}

// ───────── 알림(웹 푸시) ─────────
function renderPush() {
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  let h = `<p>저장한 기준(★ 지점·구역·경로) 근처에 <b>새 NOTAM이 나오면</b> 아이폰 알림을 받습니다. GitHub Actions가 수집할 때마다(약 15분) 비교해 보냅니다.</p>`;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) h += `<p class="warn">이 환경은 웹 푸시를 지원하지 않습니다. iOS 16.4 이상에서 <b>홈 화면에 추가한 앱</b>으로 열어야 합니다.</p>`;
  else if (!standalone && /iPhone|iPad/.test(navigator.userAgent)) h += `<p class="warn">Safari 탭에서는 알림을 켤 수 없습니다. 공유 → 홈 화면에 추가 후, 홈 화면 아이콘으로 열어 주세요.</p>`;
  h += `<div class="row"><button id="pushOn" class="main grow">알림 켜기 / 등록 정보 만들기</button></div><div id="pushOut"></div>`;
  $('pushTxt').innerHTML = h;
  $('pushOn').onclick = subscribePush;
}
function b64ToU8(b) { const p = '='.repeat((4 - b.length % 4) % 4), s = atob((b + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, c => c.charCodeAt(0)); }
async function subscribePush() {
  const out = $('pushOut');
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { out.innerHTML = '<p class="warn">알림 권한이 거부되었습니다. 설정 › 알림에서 허용하세요.</p>'; return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(VAPID_PUBLIC) });
    const refs = state.saved.length ? state.saved : (refShape() ? [refShape()] : []);
    const target = { sub: sub.toJSON(), refs: refs.map(r => ({ kind: r.kind, pts: r.pts, name: r.name, buffer: r.buffer != null ? r.buffer : state.radius })) };
    const json = JSON.stringify(target);
    out.innerHTML = `<p>✅ 이 기기 알림이 켜졌습니다. 아래 등록 정보를 복사해 GitHub 저장소 <b>Settings › Secrets and variables › Actions</b>에
      <b>PUSH_TARGETS</b> 이름의 Secret으로 넣어 주세요 (기기가 여럿이면 <code>[정보1, 정보2]</code>처럼 배열로).<br>
      감시 대상: ${refs.map(r => esc(r.name)).join(', ') || '없음 — 먼저 📌 기준에서 ★ 저장'}</p>
      <textarea readonly id="pushJson">${esc(json)}</textarea>
      <div class="row"><button id="pushCopy" class="grow">📋 복사</button></div>`;
    $('pushCopy').onclick = async () => { try { await navigator.clipboard.writeText(json); $('pushCopy').textContent = '복사됨'; } catch (e) { $('pushJson').select(); } };
  } catch (e) { out.innerHTML = `<p class="warn">등록 실패: ${esc(e.message)}</p>`; }
}

// ───────── 데이터 범위 안내 ─────────
function renderInfo() {
  const locs = state.data && state.data.locations ? state.data.locations.join(' ') : '';
  $('infoTxt').innerHTML = `
    <p><b>수집 출처</b>: ${esc(state.data ? state.data.source : 'FAA NOTAM Search')} — FAA가 재배포하는 국제(ICAO) NOTAM입니다.<br>
    <b>수집 위치지시자</b>: ${esc(locs) || '-'}</p>
    <p><b>포함되지 않거나 누락될 수 있는 것</b><br>
    · 국내 전용 NOTAM, 일부 군 NOTAM(국내 배포분)<br>
    · <b>AIP 고정 공역</b> — 금지구역(P-73 등)·제한구역(R)·위험구역(D)·군작전구역(MOA)·관제권 등 상시 공역은 NOTAM이 아니어서 표시되지 않습니다. AIP ENR 5·항공지도로 따로 확인하세요.<br>
    · 드론(초경량비행장치) 비행승인·촬영허가, 지방항공청 협의 사항<br>
    · SNOWTAM·ASHTAM, 기상(METAR/TAF/SIGMET)<br>
    · 수집 지연·실패 시 최근 15분~수 시간의 신규·취소분</p>
    <p><b>항로·고정 공역 레이어</b>: ${state.aip ? `AIM Korea eAIP ${esc(state.aip.package || '')} (ENR 3.1·3.3 항로, 5.1 P/R/D, 5.2 MOA, 5.3 CATA, 5.5 UA, 2.1 TMA) — 항로 ${state.aip.routes.length}개, 공역 ${state.aip.airspaces.length}개` : '불러오지 못함'}.
    관제권(CTR)·비행장교통구역(ATZ)·제주 Class B 등 AD 2/ENR 2.2 공역은 아직 포함되지 않습니다. "경계 근사" 표시는 해안선·분계선·호(arc)를 직선으로 근사한 것입니다.</p>
    <p>최종 확인: <a href="${AIM_URL}" target="_blank" rel="noopener" style="color:var(--acc)">AIM Korea</a></p>`;
}

// ───────── 데이터 불러오기 / 위치 ─────────
// ───────── 항로·고정 공역 (eAIP) ─────────
state.aip = store.get('nn_aip', null);
state.aipOn = store.get('nn_aipOn', { ROUTE: true, P: true, R: true, D: true, MOA: true, UA: true, CATA: false, TMA: false });
let aipGroups = null, aipShapes = {};
function aipUrl() {
  const h = location.hostname, seg = location.pathname.split('/').filter(Boolean)[0];
  if (h.endsWith('.github.io') && seg) return `https://raw.githubusercontent.com/${h.split('.')[0]}/${seg}/aip-data/aip.json`;
  return 'aip.json';
}
async function loadAip() {
  try {
    const r = await fetch(aipUrl() + '?t=' + Math.floor(Date.now() / 3600e3), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (!Array.isArray(d.routes) || !Array.isArray(d.airspaces)) throw new Error('형식 오류');
    if (!state.aip || state.aip.generated !== d.generated) {
      state.aip = d; store.set('nn_aip', d);
      if (aipGroups) { buildAipLayers(); }
      renderInfo(); render();
    }
  } catch (e) { console.warn('aip', e.message); }
}
const altLabel = (v, isUp) => !v ? '?' : v.unl ? 'UNL' : v.ft === 0 ? (isUp ? '0' : 'GND') : (v.ft >= 18000 && v.ft % 100 === 0 ? 'FL' + String(v.ft / 100).padStart(3, '0') : v.ft.toLocaleString() + 'ft' + (v.agl ? ' AGL' : ''));
function aipPopup(a) {
  const t = AIP_TYPES[a.type] || {};
  return `<b>${esc(a.name)}</b><br>${esc(t.ko || a.type)} · ${esc(a.vtext || '?')}` +
    (a.remarks ? `<br><span style="color:#555">${esc(a.remarks.slice(0, 160))}</span>` : '') +
    (a.approx ? '<br><i>경계 근사 — AIP 원문 확인</i>' : '') +
    `<br><span style="color:#777">eAIP ${esc(state.aip.package || '')} ${esc(a.section || '')}</span>`;
}
function segPopup(r, sg) {
  const a = r.points[sg.from], b = r.points[sg.to];
  return `<b>${esc(r.id)}</b> ${esc(r.spec || '')}<br>${esc(a.name)} → ${esc(b.name)}<br>` +
    `${esc(sg.track || '')} ${sg.dist != null ? sg.dist + ' NM' : ''}<br>상한 ${esc(sg.upper || '?')} / 하한 ${esc(sg.lower || '?')}` +
    (sg.mea ? `<br>최저비행고도(MEA) ${esc(sg.mea)}` : '') + `<br><span style="color:#777">eAIP ${esc(state.aip.package || '')}</span>`;
}
function initAipLayers() {
  aipGroups = {};
  const overlays = {};
  for (const [k, t] of Object.entries(AIP_TYPES)) {
    aipGroups[k] = L.layerGroup();
    if (state.aipOn[k]) aipGroups[k].addTo(map);
    overlays[`<span class="sw" style="background:${t.col}"></span>${k === 'ROUTE' ? '항로' : k + ' ' + t.ko}`] = aipGroups[k];
  }
  L.control.layers(null, overlays, { position: 'topright', collapsed: true }).addTo(map);
  map.on('overlayadd overlayremove', e => {
    for (const [k, g] of Object.entries(aipGroups)) if (g === e.layer) state.aipOn[k] = e.type === 'overlayadd';
    store.set('nn_aipOn', state.aipOn);
  });
  buildAipLayers();
}
function buildAipLayers() {
  if (!aipGroups) return;
  Object.values(aipGroups).forEach(g => g.clearLayers());
  aipShapes = {};
  if (!state.aip) return;
  const opt = { pane: 'aip' };
  for (const a of state.aip.airspaces) {
    const t = AIP_TYPES[a.type]; if (!t) continue;
    const style = Object.assign({ color: t.col, weight: a.type === 'TMA' ? 1 : 1.8, fillOpacity: a.type === 'TMA' ? 0.02 : 0.08, dashArray: a.approx ? '6 4' : (a.type === 'TMA' ? '2 4' : null) }, opt);
    const parts = a.geoms.map(g => g.kind === 'circle' ? L.circle(g.center, Object.assign({ radius: g.radiusNm * 1852 }, style)) : L.polygon(g.pts, style));
    const fg = L.featureGroup(parts).bindPopup(aipPopup(a));
    fg.addTo(aipGroups[a.type]);
    aipShapes[a.type + '|' + a.id] = fg;
  }
  for (const r of state.aip.routes) {
    const col = r.kind === 'rnav' ? '#26c6da' : '#00838f';
    const parts = r.segs.map(sg => {
      const a = r.points[sg.from], b = r.points[sg.to];
      return L.polyline([[a.lat, a.lon], [b.lat, b.lon]], Object.assign({ color: col, weight: 2, opacity: .85 }, opt)).bindPopup(segPopup(r, sg));
    });
    const mid = r.points[Math.floor(r.points.length / 2)];
    parts.push(L.marker([mid.lat, mid.lon], { opacity: 0, interactive: false, pane: 'aip' }).bindTooltip(r.id, { permanent: true, direction: 'center', className: 'rlabel' }));
    const fg = L.featureGroup(parts);
    fg.addTo(aipGroups.ROUTE);
    aipShapes['ROUTE|' + r.id] = fg;
  }
}
function renderAip(ref, af) {
  const box = $('aipBox');
  if (!state.aip || !ref) { box.hidden = true; return; }
  const list = NEAR.aipConflicts(state.aip, { ref, altLo: af.lo, altHi: af.hi, terrainFt: +state.terrain || 0 });
  const altSet = af.lo !== -Infinity || af.hi !== Infinity;
  const inCnt = list.filter(x => x.inside && x.type !== 'TMA').length;
  const altCnt = altSet ? list.filter(x => x.altOk === true).length : null;
  box.hidden = false;
  const t = `🛩 항로·고정 공역 ±${state.radius} NM: ${list.length}개` + (inCnt ? ` · <span style="color:var(--red)">겹침 ${inCnt}</span>` : '') + (altSet ? ` · 고도 겹침 ${altCnt}` : '');
  $('aipSum').innerHTML = t; $('aipTitle').innerHTML = t;
  if (!list.length) { $('aipList').innerHTML = '<div class="small" style="padding:6px 2px">기준 범위 안에 항로·고정 공역이 없습니다.</div>'; return; }
  $('aipList').innerHTML = list.map((x, i) => {
    const tp = AIP_TYPES[x.type] || {};
    let band, extra = '';
    if (x.kind === 'route') {
      const sg = x.seg, a = x.item.points[sg.from], b = x.item.points[sg.to];
      band = `${esc(sg.lower || '?')} ~ ${esc(sg.upper || '?')}${sg.mea ? ' · MEA ' + esc(sg.mea) : ''}`;
      extra = `${esc(a.name)} → ${esc(b.name)}`;
    } else {
      band = esc(x.item.vtext || '?');
      extra = esc(x.item.remarks ? x.item.remarks.slice(0, 70) : '');
    }
    const altTag = !altSet ? '' : x.altOk === true ? '<span class="tag" style="background:var(--red);color:#fff">고도 겹침</span>' : x.altOk === false ? '<span class="tag" style="background:var(--line);color:var(--dim)">고도 밖</span>' : '<span class="tag" style="background:var(--org)">고도 확인</span>';
    return `<div class="aiprow${x.inside && x.type !== 'TMA' ? ' in' : ''}" onclick="focusAip('${x.type}|${esc(x.id).replace(/'/g, "\\'")}')">
      <div><span class="tag" style="background:${tp.col}">${esc(x.type === 'ROUTE' ? '항로' : x.type)}</span>${altTag}<span class="t">${esc(x.name)}</span>${x.item.approx ? ' <span class="small">(경계 근사)</span>' : ''}<br><span class="small">${band}${extra ? ' · ' + extra : ''}</span></div>
      <div class="r">${x.inside ? (x.kind === 'route' ? '통과' : '겹침') : x.distNm.toFixed(1) + ' NM'}</div></div>`;
  }).join('');
}
function focusAip(key) {
  const fg = aipShapes[key]; if (!fg || !map) return;
  const type = key.split('|')[0];
  if (!map.hasLayer(aipGroups[type])) { aipGroups[type].addTo(map); state.aipOn[type] = true; store.set('nn_aipOn', state.aipOn); }
  $('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
  map.closePopup();
  const open = () => {
    const first = fg.getLayers().find(l => l.getPopup && l.getPopup());
    if (fg.getPopup()) fg.openPopup(fg.getBounds().getCenter()); else if (first) first.openPopup();
  };
  map.once('moveend', open);
  map.fitBounds(fg.getBounds(), { paddingTopLeft: [20, 150], paddingBottomRight: [20, 20], maxZoom: 12, animate: false });
  setTimeout(() => { if (!map._popup || !map.hasLayer(map._popup)) open(); }, 300);
}

async function loadData() {
  try {
    const u = dataUrl();
    const r = await fetch(u + (u.includes('?') ? '&' : '?') + 't=' + Math.floor(Date.now() / 60000), { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 404 ? '데이터 없음(Actions 실행 전)' : 'HTTP ' + r.status);
    const d = await r.json();
    if (!Array.isArray(d.notams)) throw new Error('형식 오류');
    state.data = { updated: d.updated, source: d.source, locations: d.locations, notams: d.notams };
    state.fetchErr = null;
    store.set('nn_data', state.data);
    if (!state.baseline) setBaseline();
  } catch (e) {
    state.fetchErr = navigator.onLine === false ? '오프라인' : e.message;
  }
  renderInfo(); render();
}
function locate() {
  if (!navigator.geolocation) return;
  $('locBtn').textContent = '📍 확인 중…';
  navigator.geolocation.getCurrentPosition(p => {
    state.pos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: new Date().toISOString() };
    store.set('nn_pos', state.pos);
    $('locBtn').textContent = '📍 내 위치';
    if (state.mode === 'gps') drawMap.fitted = null;
    render();
  }, err => {
    $('locBtn').textContent = '📍 내 위치';
    if (state.mode === 'gps') {
      const msg = err.code === 1 ? '위치 권한이 거부됨: 설정 › 개인정보 보호 › 위치 서비스 › Safari 웹사이트 › "앱을 사용하는 동안"' : '위치를 가져오지 못했습니다';
      $('status').innerHTML = `<span class="warn">${msg}</span>` + (state.pos ? ' — 마지막 위치 사용' : '');
    }
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}

// ───────── 이벤트 ─────────
function syncControls() {
  $('radius').value = String(state.radius);
  document.querySelectorAll('#win button').forEach(b => b.classList.toggle('on', String(b.dataset.h) === String(state.win.h)));
  $('custWin').hidden = state.win.h !== 'c';
  if (state.win.h === 'c') {
    if (!state.win.from) { const n = Date.now(); state.win.from = Math.ceil(n / 3600e3) * 3600e3; state.win.to = state.win.from + 6 * 3600e3; store.set('nn_win', state.win); }
    $('wFrom').value = toLocalInput(state.win.from); $('wTo').value = toLocalInput(state.win.to);
  }
  $('altLo').value = state.altLo; $('altHi').value = state.altHi; $('terrain').value = state.terrain;
  $('uncheckedBtn').classList.toggle('on2', state.onlyUnchecked);
  document.body.classList.toggle('op', state.op); document.body.classList.toggle('night', state.night);
  $('opBtn').classList.toggle('main', state.op); $('nightBtn').classList.toggle('main', state.night);
  $('paste').value = state.pasted;
}
$('locBtn').onclick = () => { state.mode = 'gps'; store.set('nn_mode', 'gps'); drawMap.fitted = null; updateModeUi(); locate(); loadData(); };
$('refBtn').onclick = () => {
  const p = $('refPanel');
  p.hidden = !p.hidden;
  if (!p.hidden) {
    setKind(state.ref ? state.ref.kind : 'point');
    if (state.ref) $('refIn').value = refToText(state.ref);
    if (state.ref && state.mode !== 'ref') { state.mode = 'ref'; store.set('nn_mode', 'ref'); drawMap.fitted = null; updateModeUi(); render(); }
  } else stopPick();
  renderSaved();
};
document.querySelectorAll('#kind button').forEach(b => b.onclick = () => { setKind(b.dataset.k); if (state.picking) startPick(); });
$('refGo').onclick = () => {
  const k = state.kindSel, txt = $('refIn').value;
  let pts;
  if (k === 'point') { const p = NEAR.parsePoint(txt.trim()); pts = p ? [p] : null; }
  else pts = NEAR.parsePointList(txt);
  const need = k === 'area' ? 3 : k === 'route' ? 2 : 1;
  if (!pts || pts.length < need) { $('refMsg').innerHTML = `<span class="warn">좌표를 읽지 못했거나 점이 부족합니다 (${need}점 이상).</span>`; return; }
  const nm = $('refName').value.trim() || (k === 'point' && pts[0].name) || KIND_KO[k];
  setRef({ kind: k, pts: pts.map(p => ({ lat: p.lat, lon: p.lon })), name: nm });
};
$('pickBtn').onclick = () => state.picking ? stopPick() : startPick();
$('pickUndo').onclick = () => { if (state.picking && state.picking.length) { state.picking.pop(); drawPick(); } };
$('pickDone').onclick = finishPick;
$('pickCancel').onclick = stopPick;
$('refSave').onclick = () => {
  const r = refShape(); if (!r) return;
  const name = $('refName').value.trim() || prompt('저장할 이름', r.name || '') || '';
  if (!name) return;
  const item = { kind: r.kind, pts: r.pts, name, buffer: state.radius };
  state.saved = state.saved.filter(x => x.name !== name).concat(item);
  store.set('nn_saved2', state.saved); renderSaved();
  if (state.mode === 'ref') { state.ref = item; store.set('nn_ref', item); render(); }
  $('refMsg').textContent = `'${name}' 저장됨`; $('refName').value = '';
};
$('mapBtn').onclick = () => { state.showMap = !state.showMap; store.set('nn_map', state.showMap); applyMapVisibility(); drawMap.fitted = null; render(); };
$('radius').onchange = e => { state.radius = +e.target.value; store.set('nn_radius', state.radius); drawMap.fitted = null; render(); };
document.querySelectorAll('#win button').forEach(b => b.onclick = () => {
  const h = b.dataset.h === 'c' ? 'c' : +b.dataset.h;
  state.win = Object.assign({}, state.win, { h });
  store.set('nn_win', state.win); syncControls(); render();
});
const onWin = () => {
  const f = fromLocalInput($('wFrom').value), t = fromLocalInput($('wTo').value);
  if (f && t) { state.win = { h: 'c', from: f, to: t > f ? t : f + 3600e3 }; store.set('nn_win', state.win); render(); }
};
$('wFrom').onchange = onWin; $('wTo').onchange = onWin;
const onAlt = () => {
  const lo = $('altLo').value.trim(), hi = $('altHi').value.trim(), ter = +$('terrain').value || 0;
  if (lo === state.altLo && hi === state.altHi && ter === state.terrain) return; // 값 변화 없으면 다시 그리지 않음
  state.altLo = lo; state.altHi = hi; state.terrain = ter;
  store.set('nn_altLo', state.altLo); store.set('nn_altHi', state.altHi); store.set('nn_terrain', state.terrain); render();
};
let altTimer = null;
['altLo', 'altHi', 'terrain'].forEach(id => { $(id).onchange = onAlt; $(id).oninput = () => { clearTimeout(altTimer); altTimer = setTimeout(onAlt, 400); }; });
$('uncheckedBtn').onclick = () => { state.onlyUnchecked = !state.onlyUnchecked; store.set('nn_unchk', state.onlyUnchecked); syncControls(); render(); };
$('opBtn').onclick = () => { state.op = !state.op; store.set('nn_op', state.op); syncControls(); render(); };
$('nightBtn').onclick = () => { state.night = !state.night; store.set('nn_night', state.night); syncControls(); };
$('baseBtn').onclick = () => {
  if (!state.data) return;
  if (!confirm('현재 목록을 새 기준으로 삼을까요?\n(이후 새로 나오거나 바뀐 NOTAM에 NEW·변경 표시가 붙습니다)')) return;
  setBaseline(); render();
};
$('printBtn').onclick = printBrief;
$('lockBtn').onclick = () => { if (window.SECURE) SECURE.lock(); };
function renderLockBox() {
  if (!window.SECURE) { $('lockBox').hidden = true; return; }
  const m = SECURE.getAutoMin();
  $('lockTxt').innerHTML = `<p>저장한 기준·시험장, 위치 기록, 확인 체크, 조회 조건, 붙여넣은 원문은 앱 암호로 암호화(AES-256-GCM)되어 이 기기에만 저장됩니다. NOTAM·항로 데이터와 화면 설정은 공개 정보라 암호화하지 않습니다.</p>
    <div class="row"><label>자동 잠금</label><select id="autoLock">${[[1, '1분'], [5, '5분'], [15, '15분'], [60, '1시간'], [0, '끄기']].map(([v, t]) => `<option value="${v}"${v === m ? ' selected' : ''}>백그라운드 ${t}${v ? ' 후' : ''}</option>`).join('')}</select></div>
    <div class="row"><input type="password" id="pwOld" class="grow" placeholder="현재 암호" autocomplete="current-password"></div>
    <div class="row"><input type="password" id="pwNew" class="grow" placeholder="새 암호 (6자 이상)" autocomplete="new-password"></div>
    <div class="row"><input type="password" id="pwNew2" class="grow" placeholder="새 암호 확인" autocomplete="new-password"></div>
    <div class="row"><button id="pwChange" class="grow">암호 변경</button><button id="lockNow" class="grow">🔒 지금 잠그기</button></div>
    <div class="small" id="pwMsg"></div>`;
  $('autoLock').onchange = e => SECURE.setAutoMin(+e.target.value);
  $('lockNow').onclick = () => SECURE.lock();
  $('pwChange').onclick = async () => {
    const o = $('pwOld').value, n = $('pwNew').value, n2 = $('pwNew2').value;
    if (n.length < 6) { $('pwMsg').innerHTML = '<span class="warn">새 암호는 6자 이상</span>'; return; }
    if (n !== n2) { $('pwMsg').innerHTML = '<span class="warn">새 암호가 서로 다릅니다</span>'; return; }
    $('pwChange').disabled = true; $('pwMsg').textContent = '바꾸는 중…';
    try { await SECURE.changePassword(o, n); $('pwMsg').textContent = '✅ 암호를 바꿨습니다.'; ['pwOld', 'pwNew', 'pwNew2'].forEach(id => $(id).value = ''); }
    catch (e) { $('pwMsg').innerHTML = '<span class="warn">현재 암호가 맞지 않습니다.</span>'; }
    $('pwChange').disabled = false;
  };
}
$('bellBtn').onclick = () => { const b = $('pushBox'); b.open = true; b.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
$('shareBtn').onclick = async () => {
  let url = shareUrl();
  if (window.CRYPT && confirm('공유 링크에 암호를 걸까요?\n(링크에 기준 좌표가 들어 있습니다. 암호를 걸면 받는 사람이 암호를 넣어야 열립니다)')) {
    const pw = prompt('링크 암호 (6자 이상, 받는 사람에게 따로 알려 주세요)');
    if (!pw) return;
    if (pw.length < 6) { alert('6자 이상으로 정해 주세요.'); return; }
    const q = url.split('#')[1];
    url = url.split('#')[0] + '#e=' + await CRYPT.encryptString(q, pw);
  }
  try {
    if (navigator.share) await navigator.share({ title: 'NOTAM 조회 조건', url });
    else { await navigator.clipboard.writeText(url); alert('링크를 복사했습니다.'); }
  } catch (e) { if (e.name !== 'AbortError') prompt('이 링크를 복사하세요', url); }
};
$('pasteBtn').onclick = () => { state.pasted = $('paste').value; store.set('nn_paste', state.pasted); render(); };
$('pasteClr').onclick = () => { $('paste').value = state.pasted = ''; store.set('nn_paste', ''); render(); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) { locate(); loadData(); } });

// ───────── 시작 ─────────
applyHash();
syncControls(); renderLockBox(); updateModeUi(); renderSaved(); renderInfo(); renderPush(); setKind('point');
$('ver').textContent = '[앱 ' + APP_VER + ']';
applyMapVisibility();
render();
locate();
loadData();
loadAip();
applyEncryptedHash();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
setInterval(() => { if (!document.hidden) render(); }, 60000);
