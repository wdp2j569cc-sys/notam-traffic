// GitHub Actions에서 주기적으로 실행: FAA NOTAM Search(키 불필요)에서 NOTAM 원문을 받아 notams.json으로 저장.
// 사용: node scripts/fetch-notams.mjs [locations.txt] [out.json]
import { readFileSync, writeFileSync } from 'node:fs';

const SEARCH_URL = 'https://notams.aim.faa.gov/notamSearch/search';
const BATCH = 10;        // 한 번에 묻는 위치지시자 수
const PAGE = 30;         // FAA 검색 페이지 크기
const MAX_PAGES = 40;

export function readLocations(text) {
  return [...new Set(text.split('\n').map(l => l.replace(/#.*/, '')).join(' ')
    .split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(s => /^[A-Z]{4}$/.test(s)))];
}

function formBody(designators, offset) {
  const p = new URLSearchParams({
    searchType: '0', designatorsForLocation: designators.join(','), designatorForAccountable: '',
    latDegrees: '', latMinutes: '0', latSeconds: '0', longDegrees: '', longMinutes: '0', longSeconds: '0',
    radius: '10', sortColumns: '5 false', sortDirection: 'true', designatorForNotamNumberSearch: '',
    notamNumber: '', radiusSearchOnDesignator: 'false', radiusSearchDesignator: '', latitudeDirection: 'N',
    longitudeDirection: 'W', freeFormText: '', flightPathText: '', flightPathDivertAirfields: '',
    flightPathBuffer: '4', flightPathIncludeNavaids: 'true', flightPathIncludeArtcc: 'false',
    flightPathIncludeTfr: 'true', flightPathIncludeRegulatory: 'false', flightPathResultsType: 'All NOTAMs',
    archiveDate: '', archiveDesignator: '', offset: String(offset), notamsOnly: 'false', filters: '',
    minRunwayLength: '', minRunwayWidth: '', runwaySurfaceTypes: '', predefinedAbraka: '', predefinedDabra: '',
    flightPathAddlBuffer: '', recaptchaToken: ''
  });
  return p.toString();
}

/** FAA 응답의 한 항목 → ICAO 원문 문자열 (없으면 null) */
export function itemToText(it) {
  const icao = (it.icaoMessage || '').trim();
  if (/Q\)|E\)/.test(icao)) return icao;
  const trad = (it.traditionalMessageFrom4thWord || it.traditionalMessage || '').trim();
  if (!trad) return null;
  // ICAO 형식이 아닌 경우(미국 국내형 등): 최소 항목을 붙여 파서가 읽을 수 있게 함
  const id = it.notamNumber && /^[A-Z]\d{4}\/\d{2}$/.test(it.notamNumber) ? it.notamNumber + ' NOTAMN\n' : '';
  return `${id}A) ${it.facilityDesignator || it.icaoId || ''}\nE) ${trad}`;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

async function errDetail(res) {
  let body = '';
  try { body = (await res.text()).replace(/\s+/g, ' ').slice(0, 200); } catch (e) {}
  return `HTTP ${res.status} ${res.headers && res.headers.get ? (res.headers.get('server') || '') : ''} ${body}`.trim();
}

/** 검색 페이지를 먼저 열어 세션 쿠키를 받음 (없으면 빈 문자열) */
async function warmup(fetchImpl) {
  try {
    const r = await fetchImpl('https://notams.aim.faa.gov/notamSearch/nsapp.html', { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
    const raw = r.headers && r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    return raw.map(c => c.split(';')[0]).join('; ');
  } catch (e) { return ''; }
}

export async function fetchAll(locations, fetchImpl = fetch, log = console.log) {
  const texts = new Map();
  const errors = [];
  const cookie = await warmup(fetchImpl);
  for (let i = 0; i < locations.length; i += BATCH) {
    const group = locations.slice(i, i + BATCH);
    for (let page = 0, offset = 0; page < MAX_PAGES; page++) {
      let data;
      try {
        const res = await fetchImpl(SEARCH_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
            'Origin': 'https://notams.aim.faa.gov',
            'Referer': 'https://notams.aim.faa.gov/notamSearch/nsapp.html',
            'User-Agent': UA,
            ...(cookie ? { 'Cookie': cookie } : {})
          },
          body: formBody(group, offset)
        });
        if (!res.ok) throw new Error(await errDetail(res));
        data = await res.json();
      } catch (e) {
        errors.push(`${group.join(',')} offset ${offset}: ${e.message}`);
        break;
      }
      if (data.error) { errors.push(`${group.join(',')}: ${data.error}`); break; }
      const list = data.notamList || [];
      for (const it of list) {
        const t = itemToText(it);
        if (t) texts.set(t.replace(/\s+/g, ' '), t);
      }
      const total = +data.totalNotamCount || 0;
      offset += list.length;
      if (!list.length || offset >= total || list.length < PAGE) break;
    }
    log(`${group.join(',')}: 누적 ${texts.size}건`);
  }
  return { notams: [...texts.values()], errors };
}

// ---- 보조 소스: FAA DINS (ICAO 원문을 <PRE> 블록으로 돌려줌) ----
const DINS_URL = 'https://www.notams.faa.gov/dinsQueryWeb/queryRetrievalMapAction.do';

export function parseDinsHtml(html) {
  const out = [];
  const re = /<pre[^>]*>([\s\S]*?)<\/pre>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const t = m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&').replace(/\r/g, '').trim();
    if (/Q\)|E\)/.test(t)) out.push(t);
  }
  return out;
}

export async function fetchDins(locations, fetchImpl = fetch, log = console.log) {
  const texts = new Map();
  const errors = [];
  for (let i = 0; i < locations.length; i += BATCH) {
    const group = locations.slice(i, i + BATCH);
    const q = new URLSearchParams({ reportType: 'Raw', retrieveLocId: group.join(' '), actionType: 'notamRetrievalByICAOs', submit: 'View NOTAMs' });
    try {
      const res = await fetchImpl(DINS_URL + '?' + q, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
      if (!res.ok) throw new Error(await errDetail(res));
      for (const t of parseDinsHtml(await res.text())) texts.set(t.replace(/\s+/g, ' '), t);
    } catch (e) {
      errors.push(`DINS ${group.join(',')}: ${e.message}`);
    }
    log(`DINS ${group.join(',')}: 누적 ${texts.size}건`);
  }
  return { notams: [...texts.values()], errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const locFile = process.argv[2] || 'notam-locations.txt';
  const out = process.argv[3] || 'notams.json';
  const locations = readLocations(readFileSync(locFile, 'utf8'));
  const a = await fetchAll(locations);
  a.errors.forEach(e => console.error('오류(NOTAM Search):', e));
  let notams = a.notams, errors = a.errors, source = 'FAA NOTAM Search (notams.aim.faa.gov)';
  if (notams.length === 0) {
    const b = await fetchDins(locations);
    b.errors.forEach(e => console.error('오류(DINS):', e));
    notams = b.notams; errors = [...a.errors, ...b.errors]; source = 'FAA DINS (notams.faa.gov)';
  }
  if (!notams.length) {
    console.error('NOTAM을 하나도 받지 못했습니다. 기존 데이터를 유지합니다.');
    process.exit(1);
  }
  writeFileSync(out, JSON.stringify({
    updated: new Date().toISOString(), source,
    locations, count: notams.length, errors, notams
  }));
  console.log(`저장: ${out} (${notams.length}건)`);
}
