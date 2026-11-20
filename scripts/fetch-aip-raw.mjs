// eAIP(AIM Korea) 원문 HTML 내려받기 → 출력 폴더에 저장 (파서 개발·갱신용)
// 사용: node scripts/fetch-aip-raw.mjs <outDir>
import { mkdirSync, writeFileSync } from 'node:fs';
const out = process.argv[2] || 'aip-raw';
mkdirSync(out, { recursive: true });
const BASE = 'https://aim.koca.go.kr/eaipPub/Package/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const log = [];
async function get(url, file) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' }, redirect: 'follow' });
    const buf = Buffer.from(await r.arrayBuffer());
    log.push(`${r.status} ${buf.length}B ${url} -> ${r.url}`);
    if (file && r.ok) writeFileSync(`${out}/${file}`, buf);
    return r.ok ? buf.toString('utf8') : null;
  } catch (e) { log.push(`ERR ${url} ${e.cause ? e.cause.code || e.cause.message : e.message}`); return null; }
}
// 1) 패키지 목록 찾기
const idx = [];
for (const [u, f] of [[BASE + 'history-en-GB.html', 'history-en-GB.html'], [BASE, 'package-root.html'],
  ['https://aim.koca.go.kr/eaipPub/', 'eaippub-root.html'], [BASE + 'index.html', 'package-index.html'],
  ['https://aim.koca.go.kr/aim/viewCatalog.do?gubun=2', 'catalog.html']]) {
  const t = await get(u, f); if (t) idx.push(t);
}
const dates = [...new Set(idx.join('\n').match(/20\d\d-\d\d-\d\d(?:-AIRAC)?/g) || [])].sort();
log.push('package dates found: ' + dates.slice(-15).join(' '));
// 2) 가장 최근(오늘 이전) 패키지 + 검색에서 알려진 2025-05-01로 ENR 페이지 받기
const today = new Date().toISOString().slice(0, 10);
const cands = [...dates.filter(d => d.slice(0, 10) <= today).reverse().slice(0, 3), '2025-05-01'];
let pkg = null;
for (const d of cands) {
  const t = await get(`${BASE}${d}/html/eAIP/KR-ENR-3.1-en-GB.html`, null);
  if (t) { pkg = d; break; }
}
log.push('using package: ' + pkg);
if (pkg) {
  for (const s of ['2.1', '2.2', '3.1', '3.2', '3.3', '3.5', '4.1', '4.4', '5.1', '5.2', '5.3', '5.5', '5.6']) {
    await get(`${BASE}${pkg}/html/eAIP/KR-ENR-${s}-en-GB.html`, `KR-ENR-${s}.html`);
  }
  await get(`${BASE}${pkg}/html/index-en-GB.html`, 'pkg-index-en-GB.html');
  await get(`${BASE}${pkg}/html/eAIP/KR-menu-en-GB.html`, 'pkg-menu-en-GB.html');
}
writeFileSync(`${out}/_log.txt`, log.join('\n') + '\n');
console.log(log.join('\n'));
