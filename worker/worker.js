/**
 * NOTAM·항적 중계 서버 (Cloudflare Workers, 무료 플랜으로 충분)
 *
 * GET /notam?lat=36.63&lon=128.35&r=25&loc=RKRR,RKTY
 *   → { notams: [ICAO 원문 문자열...], source, errors: [] }
 * GET /traffic?lat=36.63&lon=128.35&r=25
 *   → { aircraft: [{hex, flight, reg, type, lat, lon, alt, gs, track, vr, ground, squawk, src}], source, errors }
 *
 * 비밀값(Secrets) — `npx wrangler secret put 이름`
 *   FAA_CLIENT_ID, FAA_CLIENT_SECRET   : FAA NMS API 자격증명 (NOTAMS@faa.gov 에 요청)
 *   OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET : (선택) OpenSky API 클라이언트
 * 일반 변수(Vars)
 *   ALLOWED_ORIGIN : 예) https://wdp2j569cc-sys.github.io  (비우면 *)
 */

const NMS_AUTH = 'https://api-nms.aim.faa.gov/v1/auth/token';
const NMS_API = 'https://api-nms.aim.faa.gov/nmsapi';
const OPENSKY_AUTH = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

let nmsToken = null, nmsExp = 0;
let osToken = null, osExp = 0;

export default {
  async fetch(req, env, ctx) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);
    try {
      let body;
      if (url.pathname === '/notam') body = await handleNotam(url, env, ctx);
      else if (url.pathname === '/traffic') body = await handleTraffic(url, env);
      else if (url.pathname === '/') body = { ok: true, endpoints: ['/notam', '/traffic'] };
      else return json({ error: 'not found' }, 404, cors);
      return json(body, 200, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, cors);
    }
  }
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers)
  });
}

function num(v, name, min, max) {
  const x = parseFloat(v);
  if (!isFinite(x) || x < min || x > max) throw new Error(`잘못된 ${name}: ${v}`);
  return x;
}

async function fetchJson(u, init, timeoutMs = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(u, Object.assign({ signal: ac.signal }, init));
    if (!r.ok) throw new Error(`${new URL(u).host} ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* ───────────── NOTAM (FAA NMS API) ───────────── */
async function getNmsToken(env) {
  if (nmsToken && Date.now() < nmsExp) return nmsToken;
  if (!env.FAA_CLIENT_ID || !env.FAA_CLIENT_SECRET) throw new Error('FAA_CLIENT_ID / FAA_CLIENT_SECRET 미설정');
  const r = await fetch(NMS_AUTH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${env.FAA_CLIENT_ID}:${env.FAA_CLIENT_SECRET}`)
    },
    body: 'grant_type=client_credentials'
  });
  if (!r.ok) throw new Error(`NMS 토큰 발급 실패 ${r.status}`);
  const j = await r.json();
  nmsToken = j.access_token;
  nmsExp = Date.now() + ((j.expires_in || 1800) - 60) * 1000;
  return nmsToken;
}

async function nmsQuery(env, params) {
  const token = await getNmsToken(env);
  const qs = new URLSearchParams(params).toString();
  const j = await fetchJson(`${NMS_API}/v1/notams?${qs}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'nmsResponseFormat': 'GEOJSON' }
  });
  const feats = (j && j.data && j.data.geojson) || [];
  const out = [];
  for (const f of feats) {
    const texts = findIcaoTexts(f);
    if (texts.length) { out.push(texts.sort((a, b) => b.length - a.length)[0]); continue; }
    const fb = buildFromFields(f);
    if (fb) out.push(fb);
  }
  return out;
}

/** GeoJSON 속성 안에서 ICAO 형식 원문(Q) … E) …)을 재귀 탐색 */
function findIcaoTexts(obj, out = [], depth = 0) {
  if (depth > 8 || obj == null) return out;
  if (typeof obj === 'string') { if (/Q\)\s*[A-Z]{4}\//.test(obj) && /E\)/.test(obj)) out.push(obj); return out; }
  if (Array.isArray(obj)) { for (const v of obj) findIcaoTexts(v, out, depth + 1); return out; }
  if (typeof obj === 'object') for (const v of Object.values(obj)) findIcaoTexts(v, out, depth + 1);
  return out;
}

/** 원문이 없을 때 필드에서 최소한의 ICAO 형식 재구성 (필드명은 FAA NOTAM API 계열 기준, 없으면 건너뜀) */
function buildFromFields(f) {
  const n = (f && f.properties && f.properties.coreNOTAMData && f.properties.coreNOTAMData.notam) || null;
  if (!n || !n.text) return null;
  const t = s => s ? String(s).replace(/[-:T]/g, '').slice(2, 12) : '';
  const id = n.number && n.series ? `${n.series}${n.number}` : (n.number || n.id || 'X0000/00');
  return `${id} NOTAMN\nQ) ${n.icaoLocation || 'RKRR'}/QXXXX/IV/NBO/AE/000/999/${n.coordinates || ''}\nA) ${n.icaoLocation || n.location || ''} B) ${t(n.effectiveStart)} C) ${/PERM/i.test(n.effectiveEnd || '') ? 'PERM' : t(n.effectiveEnd)}\nE) ${n.text}`;
}

async function handleNotam(url, env, ctx) {
  const lat = num(url.searchParams.get('lat'), 'lat', -90, 90);
  const lon = num(url.searchParams.get('lon'), 'lon', -180, 180);
  const r = num(url.searchParams.get('r') || '25', 'r', 1, 250);
  const locs = (url.searchParams.get('loc') || 'RKRR').split(',').map(s => s.trim().toUpperCase())
    .filter(s => /^[A-Z]{4}$/.test(s)).slice(0, 15);

  // 엣지 캐시 5분 (같은 요청 반복 시 FAA 호출 절약)
  const cache = caches.default;
  const key = new Request(`https://cache.local/notam?${[lat.toFixed(2), lon.toFixed(2), Math.round(r), locs.join(',')].join('&')}`);
  const hit = await cache.match(key);
  if (hit) return await hit.json();

  const jobs = [
    ...locs.map(l => nmsQuery(env, { location: l }).then(v => ({ tag: l, v }))),
    nmsQuery(env, { latitude: lat.toFixed(4), longitude: lon.toFixed(4), radius: Math.round(Math.min(r, 100)) }).then(v => ({ tag: 'radius', v }))
  ];
  const res = await Promise.allSettled(jobs);
  const set = new Set(), errors = [];
  res.forEach((x, i) => {
    if (x.status === 'fulfilled') x.value.v.forEach(t => set.add(t.trim()));
    else errors.push(`${i < locs.length ? locs[i] : 'radius'}: ${x.reason && x.reason.message || x.reason}`);
  });
  const body = { notams: [...set], source: 'FAA NMS', errors, fetchedAt: new Date().toISOString() };
  if (set.size || !errors.length) {
    ctx.waitUntil(cache.put(key, new Response(JSON.stringify(body), { headers: { 'Cache-Control': 'max-age=300' } })));
  }
  return body;
}

/* ───────────── 항적 (ADS-B) ───────────── */
function normReadsb(ac, src) {
  return (ac || []).filter(a => a.lat != null && a.lon != null).map(a => ({
    hex: a.hex, flight: (a.flight || '').trim(), reg: a.r || '', type: a.t || '',
    lat: a.lat, lon: a.lon, ground: a.alt_baro === 'ground',
    alt: a.alt_baro === 'ground' ? 0 : (typeof a.alt_baro === 'number' ? a.alt_baro : (a.alt_geom ?? null)),
    gs: a.gs ?? null, track: a.track ?? a.true_heading ?? null, vr: a.baro_rate ?? a.geom_rate ?? null,
    squawk: a.squawk || '', src
  }));
}

async function getOpenSkyToken(env) {
  if (!env.OPENSKY_CLIENT_ID) return null;
  if (osToken && Date.now() < osExp) return osToken;
  const r = await fetch(OPENSKY_AUTH, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.OPENSKY_CLIENT_ID, client_secret: env.OPENSKY_CLIENT_SECRET || '' })
  });
  if (!r.ok) return null;
  const j = await r.json();
  osToken = j.access_token; osExp = Date.now() + ((j.expires_in || 1800) - 60) * 1000;
  return osToken;
}

async function openSky(env, lat, lon, r) {
  const dLat = r / 60, dLon = r / (60 * Math.cos(lat * Math.PI / 180));
  const u = `https://opensky-network.org/api/states/all?lamin=${(lat - dLat).toFixed(3)}&lamax=${(lat + dLat).toFixed(3)}&lomin=${(lon - dLon).toFixed(3)}&lomax=${(lon + dLon).toFixed(3)}`;
  const tok = await getOpenSkyToken(env).catch(() => null);
  const j = await fetchJson(u, tok ? { headers: { Authorization: `Bearer ${tok}` } } : {});
  return (j.states || []).filter(s => s[5] != null && s[6] != null).map(s => ({
    hex: s[0], flight: (s[1] || '').trim(), reg: '', type: '', lat: s[6], lon: s[5], ground: !!s[8],
    alt: s[8] ? 0 : (s[7] != null ? s[7] * 3.28084 : (s[13] != null ? s[13] * 3.28084 : null)),
    gs: s[9] != null ? s[9] * 1.94384 : null, track: s[10], vr: s[11] != null ? s[11] * 196.85 : null,
    squawk: s[14] || '', src: 'OpenSky'
  }));
}

async function handleTraffic(url, env) {
  const lat = num(url.searchParams.get('lat'), 'lat', -90, 90);
  const lon = num(url.searchParams.get('lon'), 'lon', -180, 180);
  const r = Math.round(num(url.searchParams.get('r') || '25', 'r', 1, 250));
  const ua = { headers: { 'User-Agent': 'notam-traffic-relay/1.0' } };
  const sources = [
    ['airplanes.live', () => fetchJson(`https://api.airplanes.live/v2/point/${lat}/${lon}/${r}`, ua).then(j => normReadsb(j.ac, 'airplanes.live'))],
    ['adsb.fi', () => fetchJson(`https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${r}`, ua).then(j => normReadsb(j.ac || j.aircraft, 'adsb.fi'))],
    ['adsb.lol', () => fetchJson(`https://api.adsb.lol/v2/point/${lat}/${lon}/${r}`, ua).then(j => normReadsb(j.ac, 'adsb.lol'))],
    ['OpenSky', () => openSky(env, lat, lon, r)]
  ];
  const errors = [];
  for (const [name, fn] of sources) {
    try {
      const aircraft = await fn();
      return { aircraft, source: name, errors, time: Date.now() };
    } catch (e) {
      errors.push(`${name}: ${e.message || e}`);
    }
  }
  return { aircraft: [], source: '없음', errors, time: Date.now() };
}
