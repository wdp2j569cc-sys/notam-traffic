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

export async function fetchAll(locations, fetchImpl = fetch, log = console.log) {
  const texts = new Map();
  const errors = [];
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
            'User-Agent': 'Mozilla/5.0 (notam-traffic GitHub Action)'
          },
          body: formBody(group, offset)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const locFile = process.argv[2] || 'notam-locations.txt';
  const out = process.argv[3] || 'notams.json';
  const locations = readLocations(readFileSync(locFile, 'utf8'));
  const { notams, errors } = await fetchAll(locations);
  errors.forEach(e => console.error('오류:', e));
  if (!notams.length) {
    console.error('NOTAM을 하나도 받지 못했습니다. 기존 데이터를 유지합니다.');
    process.exit(1);
  }
  writeFileSync(out, JSON.stringify({
    updated: new Date().toISOString(), source: 'FAA NOTAM Search (notams.aim.faa.gov)',
    locations, count: notams.length, errors, notams
  }));
  console.log(`저장: ${out} (${notams.length}건)`);
}
