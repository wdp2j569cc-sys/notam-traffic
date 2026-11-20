// eAIP(AIM Korea) HTML → 항로·공역 데이터(aip.json)
// 사용: node scripts/parse-aip.mjs <rawDir> <out.json> [package]
// 대상: ENR 3.1(재래식 항로), 3.3(RNAV 항로), 5.1(P/R/D), 5.2(MOA), 5.3(CATA), 5.5(UA), 2.1(TMA)
// 개정으로 삭제 표시(AmdtDeleted)된 행·문구는 제외한다.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// ───────── HTML 보조 ─────────
const VOID = new Set(['br', 'img', 'hr', 'meta', 'link', 'input', 'col', 'area', 'base', 'wbr', 'source']);
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", deg: '°', ndash: '–', mdash: '—' };
const decode = s => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
  return ENT[e.toLowerCase()] ?? m;
});

/** 삭제 표시 요소를 뺀 텍스트. <p>/<br>/<tr>/<td>는 줄바꿈·공백으로 */
export function textOf(html) {
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>|([^<]+)/g;
  const stack = [];
  let out = '', del = 0, m;
  while ((m = re.exec(html)) !== null) {
    if (m[5] !== undefined) { if (!del) out += m[5]; continue; }
    const [, close, tagRaw, attrs, selfClose] = m;
    const tag = tagRaw.toLowerCase();
    if (!close) {
      if (['p', 'br', 'tr', 'div', 'li'].includes(tag)) out += '\n';
      if (tag === 'td' || tag === 'th') out += ' ';
      if (VOID.has(tag) || selfClose) continue;
      const isDel = /class="[^"]*AmdtDeleted/.test(attrs);
      stack.push({ tag, isDel });
      if (isDel) del++;
    } else {
      while (stack.length) {
        const top = stack.pop();
        if (top.isDel) del--;
        if (top.tag === tag) break;
      }
    }
  }
  return decode(out).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
}

/** html 안의 최상위 <tag> 요소들 (중첩 같은 태그 고려) → [{attrs, inner}] */
export function topLevel(html, tag) {
  const re = new RegExp(`<(/?)${tag}\\b([^>]*)>`, 'gi');
  const out = [];
  let depth = 0, start = 0, attrs = '', m;
  while ((m = re.exec(html)) !== null) {
    if (!m[1]) {
      if (/\/\s*$/.test(m[2])) continue;
      if (depth === 0) { start = re.lastIndex; attrs = m[2]; }
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) out.push({ attrs, inner: html.slice(start, m.index) });
    }
  }
  return out;
}
/** 표의 행(최상위 tr) → [{cls, cells:[html]}] — 중첩 표(Upper/Lower)는 셀 안에 그대로 둠 */
function rowsOf(html) {
  const out = [];
  for (const tb of topLevel(html, 'table')) {
    for (const tr of topLevel(tb.inner.replace(/<\/?(?:thead|tbody|tfoot)\b[^>]*>/gi, ''), 'tr')) {
      const cls = (tr.attrs.match(/class="([^"]*)"/) || [, ''])[1];
      out.push({ cls, cells: topLevel(tr.inner, 'td').map(c => c.inner) });
    }
  }
  return out;
}

// ───────── 좌표·고도 ─────────
const COORD = /(\d{2})(\d{2})(\d{2}(?:\.\d+)?)?\s*([NS])\s*(\d{3})(\d{2})(\d{2}(?:\.\d+)?)?\s*([EW])/g;
export function coordsIn(text) {
  const pts = [];
  let m;
  COORD.lastIndex = 0;
  while ((m = COORD.exec(text)) !== null) {
    let lat = +m[1] + +m[2] / 60 + (m[3] ? +m[3] / 3600 : 0), lon = +m[5] + +m[6] / 60 + (m[7] ? +m[7] / 3600 : 0);
    if (m[4] === 'S') lat = -lat;
    if (m[8] === 'W') lon = -lon;
    pts.push({ lat: +lat.toFixed(6), lon: +lon.toFixed(6), idx: m.index, end: COORD.lastIndex });
  }
  return pts;
}
/** 고도 문자열 → ft (UNL=Infinity, GND/SFC=0). 숫자만 있으면 ft. AGL 여부 표시. 해석 불가 null */
export function altFt(s) {
  if (!s) return null;
  const t = String(s).toUpperCase().replace(/(\d)\s+(?=\d{3}\b)/g, '$1').trim();
  if (/^(UNL|UNLTD)/.test(t)) return { ft: Infinity, agl: false };
  if (/^(GND|SFC|MSL)/.test(t)) return { ft: 0, agl: false };
  let m = t.match(/^FL\s*(\d{2,3})/);
  if (m) return { ft: +m[1] * 100, agl: false };
  m = t.match(/^(\d+(?:\.\d+)?)\s*(FT|M)?\s*(AGL|AMSL|MSL|ALT)?/);
  if (m) return { ft: m[2] === 'M' ? Math.round(+m[1] * 3.28084) : +m[1], agl: m[3] === 'AGL' };
  return null;
}
/** "UNL/GND", "FL 150/ GND", "FL 500 / 10 000 ft AMSL", "500 ft AGL/SFC" → {upper, lower, text} */
export function vertical(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/(UNL|FL\s*\d{2,3}|\d[\d ]*(?:\.\d+)?\s*(?:ft|m)?\s*(?:AMSL|AGL|MSL)?)\s*\/\s*(GND|SFC|FL\s*\d{2,3}|\d[\d ]*(?:\.\d+)?\s*(?:ft|m)?\s*(?:AMSL|AGL|MSL)?)/i);
  if (!m) return { upper: null, lower: null, text: t };
  return { upper: altFt(m[1]), lower: altFt(m[2]), text: `${m[1].trim()} / ${m[2].trim()}` };
}

// ───────── 항로 ─────────
function upperLower(cellHtml) {
  const up = (cellHtml.match(/<td class="Upper"[^>]*>([\s\S]*?)<\/td>/) || [])[1];
  const lo = (cellHtml.match(/<td class="Lower"[^>]*>([\s\S]*?)<\/td>/) || [])[1];
  return up !== undefined || lo !== undefined ? [textOf(up || ''), textOf(lo || '')] : null;
}
export function parseRoutes(html, kind) {
  const routes = [];
  let cur = null, last = null, seg = null;
  for (const r of rowsOf(html)) {
    if (/AmdtDeleted/.test(r.cls)) continue;
    if (/Table-row-type-1/.test(r.cls)) {
      const id = (r.cells[0] && (r.cells[0].match(/class="Route-designator[^"]*"[^>]*>([\s\S]*?)<\/p>/) || [])[1]) || '';
      const name = textOf(id).trim();
      if (!name) continue;
      const spec = textOf(r.cells[0].replace(/<p class="Route-designator[\s\S]*?<\/p>/, '')).replace(/\s+/g, ' ').trim();
      cur = { id: name, kind, spec, points: [], segs: [] };
      routes.push(cur); last = null; seg = null;
    } else if (/Table-row-type-2/.test(r.cls) && cur) {
      const name = textOf(r.cells[1] || '').replace(/\s+/g, ' ').trim();
      const c = coordsIn(textOf(r.cells[2] || ''))[0];
      if (!c) continue;
      const pt = { name, lat: c.lat, lon: c.lon };
      if (last && seg) cur.segs.push(Object.assign({ from: cur.points.length - 1, to: cur.points.length }, seg));
      cur.points.push(pt); last = pt; seg = null;
    } else if (/Table-row-type-3/.test(r.cls) && cur) {
      const ul = r.cells.map(upperLower).filter(Boolean);
      const plain = r.cells.filter(c => !/UpperAndLower/.test(c)).map(c => textOf(c).replace(/\s+/g, ' ').trim());
      const dist = plain.map(t => t.match(/^(\d+(?:\.\d+)?)$/)).find(Boolean);
      const meaTxt = plain.find(t => /^(\d[\d ]*\s*ft\s*(AMSL|AGL)|FL\s*\d{2,3})$/i.test(t));
      const lim = ul[1] || null, trk = ul[0] || null;
      seg = {
        track: trk ? trk[0] : null, dist: dist ? +dist[1] : null,
        upper: lim ? lim[0] : null, lower: lim ? lim[1] : null, mea: meaTxt || null,
        upperFt: lim ? numFt(lim[0]) : null, lowerFt: lim ? numFt(lim[1]) : null, meaFt: meaTxt ? numFt(meaTxt) : null
      };
    }
  }
  return routes.filter(r => r.points.length >= 2);
}
const numFt = s => { const a = altFt(s); return a ? (a.ft === Infinity ? null : a.ft) : null; };

// ───────── 공역 ─────────
const R_UNIT = { NM: 1, KM: 1 / 1.852, MILES: 1, MILE: 1 };
/** 경계 문구 → 형상 [{kind:'polygon',pts}|{kind:'circle',center,radiusNm}], approx 여부 */
export function boundary(text) {
  let t = String(text).replace(/\s+/g, ' ');
  // 첫 경계 서술만 사용 (뒤에 붙는 회랑·부속 구역 설명 제외)
  const stop = t.search(/to the beginning|to point of origin|to coast-?line|to the point of origin/i);
  if (stop >= 0) t = t.slice(0, stop + 20);
  const geoms = [];
  let approx = /along|coast|arc|border|demarcation|boundary of|except/i.test(t);
  // 지름 표기: "A Circle 4 NM in diameter centered at ... (3453N 12857E)"
  let m = t.match(/circle\s+([\d.]+)\s*(NM|KM)\s+in\s+diameter[^]*?centered\s+(?:on|at)/i);
  if (m) {
    const c = coordsIn(t.slice(m.index))[0];
    if (c) return { geoms: [{ kind: 'circle', center: [c.lat, c.lon], radiusNm: +m[1] * (R_UNIT[m[2].toUpperCase()] || 1) / 2 }], approx };
  }
  // 반경 표기: "circle radius 5 NM centered on", "Circle with radius of 1.8 km(1.0 NM) centered on", "circles with a radius of 2 miles centered on center 1 and center 2"
  m = t.match(/circles?\s*,?\s*(?:with\s+)?(?:a\s+)?radius\s+(?:of\s+)?([\d.]+)\s*(NM|KM|miles?)(?:\s*\(\s*([\d.]+)\s*NM\s*\))?/i);
  if (m && !/arc/i.test(t)) {
    const r = m[3] ? +m[3] : +m[1] * (R_UNIT[m[2].toUpperCase()] || 1);
    const cs = coordsIn(t.slice(m.index));
    if (cs.length) {
      cs.forEach(c => geoms.push({ kind: 'circle', center: [c.lat, c.lon], radiusNm: r }));
      return { geoms, approx: approx || cs.length > 1 };
    }
  }
  const pts = coordsIn(t);
  if (pts.length >= 3) {
    const p = pts.map(c => [c.lat, c.lon]);
    const a = p[0], b = p[p.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) p.pop();
    // "군사분계선과 다음 선 사이 구역"(P518 등): 선의 북쪽 전체로 보수적 근사 (북위 38.65°까지 확장)
    if (/area between (the )?Demarcation and the line/i.test(t)) {
      p.push([38.65, p[p.length - 1][1]], [38.65, p[0][1]]);
      approx = true;
    }
    geoms.push({ kind: 'polygon', pts: p });
  }
  return { geoms, approx };
}

function typeOf(id) {
  const m = id.match(/^RK\s*([PRD])\s*\d/);
  if (m) return m[1];
  if (/^MOA/i.test(id)) return 'MOA';
  if (/^CATA/i.test(id)) return 'CATA';
  if (/^\(?UA\s*\d/i.test(id)) return 'UA';
  return null;
}

/** ENR 5.x: 첫 셀 = 이름+경계, 둘째 셀 = 상/하한, 셋째 셀 = 비고 */
export function parseEnr5(html, section) {
  const out = [];
  for (const r of rowsOf(html)) {
    if (/AmdtDeleted/.test(r.cls) || r.cells.length < 2) continue;
    const first = textOf(r.cells[0]);
    const lines = first.split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) continue;
    let name = lines[0].replace(/\s+/g, ' ');
    // 5.3 형식: "CATA 1 ULLEUNG ISLAND 382502N ..." 처럼 첫 줄에 좌표가 붙는 경우 잘라냄
    const ci = coordsIn(name)[0];
    if (ci) name = name.slice(0, ci.idx).trim();
    const type = typeOf(name);
    if (!type) continue;
    const b = boundary(lines.slice(1).join(' ') + (ci ? ' ' + lines[0].slice(ci.idx) : ''));
    if (!b.geoms.length) continue;
    const vt = vertical(textOf(r.cells[1]));
    const remarks = r.cells.slice(2).map(c => textOf(c)).join('\n').split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' · ');
    const [ident, ...rest] = name.split(/\s+(?=[A-Z][A-Z-]+(?:\s|\(|$))/);
    out.push({ id: name.match(/^(RK\s*[PRD]\s*\w+|MOA\s*\w+|CATA\s*\d+|\(UA\s*\d+\))/i)?.[0].replace(/\s+/g, ' ') || name,
      name, type, section, geoms: b.geoms, approx: b.approx, upper: vt.upper, lower: vt.lower, vtext: vt.text, remarks: remarks.slice(0, 300) });
  }
  return out;
}

/** ENR 2.1 TMA: "Seoul Terminal Control Area / T 01 / 좌표… / FL 185 / FL 175 / Class D" */
export function parseTma(html) {
  const out = [];
  let group = null;
  for (const r of rowsOf(html)) {
    if (/AmdtDeleted/.test(r.cls) || !r.cells.length) continue;
    const t = textOf(r.cells[0]);
    const g = t.match(/^([A-Za-z]+ Terminal Control Area)/i);
    if (g) group = g[1].replace(/\s+/g, ' ');
    if (/^Incheon FIR/i.test(t)) { group = null; continue; }
    const sec = t.match(/(?:^|\n)\s*(T\s*\d{2}|S\d[^\n]*)/);
    if (!group || !sec) continue;
    const cs = coordsIn(t);
    if (cs.length < 3) continue;
    const after = t.slice(cs[cs.length - 1].end);
    const vt = vertical(after);
    const cls = (after.match(/Class\s+[A-G](?:\s*,\s*[A-G])*/i) || [''])[0];
    const b = boundary(t.slice(cs[0].idx, cs[cs.length - 1].end));
    const label = sec[1].trim().replace(/\s+/g, ' ');
    out.push({ id: `${group.replace(/ Terminal Control Area/i, ' TMA')} ${label.replace(/\(.*$/, '').trim()}`, name: `${group} ${label}`, type: 'TMA',
      section: 'ENR 2.1', geoms: b.geoms, approx: b.approx || /Arc/i.test(t), upper: vt.upper, lower: vt.lower, vtext: vt.text, remarks: cls });
  }
  return out;
}

// ───────── 실행 ─────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, outFile, pkg] = process.argv.slice(2);
  const rd = f => existsSync(`${dir}/${f}`) ? readFileSync(`${dir}/${f}`, 'utf8') : '';
  const routes = [...parseRoutes(rd('KR-ENR-3.1.html'), 'conv'), ...parseRoutes(rd('KR-ENR-3.3.html'), 'rnav')];
  const airspaces = [
    ...parseEnr5(rd('KR-ENR-5.1.html'), 'ENR 5.1'), ...parseEnr5(rd('KR-ENR-5.2.html'), 'ENR 5.2'),
    ...parseEnr5(rd('KR-ENR-5.3.html'), 'ENR 5.3'), ...parseEnr5(rd('KR-ENR-5.5.html'), 'ENR 5.5'),
    ...parseTma(rd('KR-ENR-2.1.html'))
  ];
  // 같은 식별자가 다른 표에 다시 나오면(상세 표 등) 처음 것만 사용
  const seenId = new Set();
  for (let i = airspaces.length - 1; i >= 0; i--) airspaces[i]._i = i;
  const uniq = airspaces.filter(a => { const k = a.type + '|' + a.id; if (seenId.has(k)) return false; seenId.add(k); return true; });
  airspaces.length = 0; uniq.forEach(a => { delete a._i; airspaces.push(a); });
  const fin = v => v && v.ft === Infinity ? Object.assign({}, v, { ft: null, unl: true }) : v; // JSON에 Infinity 불가
  const data = {
    package: pkg || null, generated: new Date().toISOString(), source: 'AIM Korea eAIP (aim.koca.go.kr)',
    routes, airspaces: airspaces.map(a => Object.assign({}, a, { upper: fin(a.upper), lower: fin(a.lower) }))
  };
  const counts = {};
  airspaces.forEach(a => counts[a.type] = (counts[a.type] || 0) + 1);
  if (routes.length < 10 || airspaces.length < 20) {
    console.error(`파싱 결과가 너무 적습니다 (항로 ${routes.length}, 공역 ${airspaces.length}). eAIP 형식 변경 가능성 — 기존 데이터 유지.`);
    process.exit(1);
  }
  writeFileSync(outFile, JSON.stringify(data));
  console.log(`항로 ${routes.length}개 (구간 ${routes.reduce((a, r) => a + r.segs.length, 0)}), 공역 ${airspaces.length}개 ${JSON.stringify(counts)}, 근사 경계 ${airspaces.filter(a => a.approx).length}개`);
}
