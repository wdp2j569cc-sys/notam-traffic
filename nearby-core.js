/* nearby-core.js — 내 주변 NOTAM 판정 로직 (브라우저·Node 공용)
 * 기준 형상(지점·구역·경로)과의 거리, D항목 운용시간, 고도 범위, Q코드 분류, 좌표 해석 */
(function (root) {
  'use strict';
  const N = root.NOTAM || (typeof require !== 'undefined' ? require('./notam.js') : null);
  const DAY = 864e5;

  // ───────── 좌표 해석 ─────────
  const AIRPORTS = {
    RKSI: ['인천', 37.4691, 126.4505], RKSS: ['김포', 37.5583, 126.7906], RKPC: ['제주', 33.5113, 126.4930],
    RKPK: ['김해', 35.1795, 128.9382], RKTN: ['대구', 35.8941, 128.6589], RKJJ: ['광주', 35.1264, 126.8089],
    RKJB: ['무안', 34.9914, 126.3828], RKNY: ['양양', 38.0613, 128.6692], RKTU: ['청주', 36.7166, 127.4991],
    RKNW: ['원주', 37.4383, 127.9604], RKPU: ['울산', 35.5935, 129.3518], RKJY: ['여수', 34.8423, 127.6169],
    RKTH: ['포항', 35.9879, 129.4203], RKPS: ['사천', 35.0886, 128.0703], RKJK: ['군산', 35.9038, 126.6158],
    RKSM: ['서울(성남)', 37.4458, 127.1139], RKSO: ['오산', 37.0906, 127.0297], RKSG: ['험프리스', 36.9617, 127.0311],
    RKSW: ['수원', 37.2394, 127.0071], RKTY: ['예천', 36.6319, 128.3550], RKNN: ['강릉', 37.7536, 128.9439],
    RKPD: ['정석', 33.3990, 126.7118], RKPE: ['진해', 35.1408, 128.6964], RKTI: ['중원', 36.9658, 127.8853],
    RKTL: ['울진', 36.7772, 129.4619]
  };
  const okLL = (lat, lon) => isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;

  /** 한 지점: "36.514, 127.247" / "363406N1273157E" / "3634N12731E" / "N36°34'06\" E127°31'57\"" / "36 34 06N 127 31 57E" / "RKTU" */
  function parsePoint(str) {
    const t = String(str || '').trim().toUpperCase();
    if (!t) return null;
    if (AIRPORTS[t]) return { lat: AIRPORTS[t][1], lon: AIRPORTS[t][2], name: `${t} ${AIRPORTS[t][0]}` };
    let m = t.replace(/\s+/g, '').match(/^(\d{2})(\d{2})(\d{2}(?:\.\d+)?)?([NS])(\d{3})(\d{2})(\d{2}(?:\.\d+)?)?([EW])$/);
    if (m) {
      const lat = +m[1] + +m[2] / 60 + (m[3] ? +m[3] / 3600 : 0), lon = +m[5] + +m[6] / 60 + (m[7] ? +m[7] / 3600 : 0);
      return okLL(m[4] === 'S' ? -lat : lat, m[8] === 'W' ? -lon : lon);
    }
    const p = t.replace(/[°'"′″:]/g, ' ').match(/^([NS]?)\s*(\d+(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?))?(?:\s+(\d+(?:\.\d+)?))?\s*([NS]?)[\s,]+([EW]?)\s*(\d+(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?))?(?:\s+(\d+(?:\.\d+)?))?\s*([EW]?)$/);
    if (p) {
      const dms = (d, mi, se) => +d + (mi ? +mi / 60 : 0) + (se ? +se / 3600 : 0);
      let lat = dms(p[2], p[3], p[4]), lon = dms(p[7], p[8], p[9]);
      if ((p[1] || p[5]) === 'S') lat = -lat;
      if ((p[6] || p[10]) === 'W') lon = -lon;
      return okLL(lat, lon);
    }
    return null;
  }

  /** 여러 지점: 줄바꿈·';'·' - ' 구분, 또는 NOTAM식 좌표 나열 "363406N1273157E 363500N1274000E ..." */
  function parsePointList(str) {
    const t = String(str || '').toUpperCase();
    const compact = t.match(/\d{4,6}(?:\.\d+)?[NS]\s?\d{5,7}(?:\.\d+)?[EW]/g);
    if (compact && compact.length >= 2) return compact.map(parsePoint).filter(Boolean);
    const parts = t.split(/\n|;|\s+-\s+|\s*→\s*/).map(s => s.trim()).filter(Boolean);
    const pts = parts.map(parsePoint);
    return pts.every(Boolean) ? pts : null;
  }

  // ───────── 기하 (기준점 둘레 평면 근사, 단위 NM) ─────────
  function projector(lat0, lon0) {
    const k = Math.cos(lat0 * Math.PI / 180) * 60;
    return p => [(p[1] - lon0) * k, (p[0] - lat0) * 60];
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const len = v => Math.hypot(v[0], v[1]);
  function ptSeg(p, a, b) {
    const ab = sub(b, a), ap = sub(p, a), L2 = ab[0] * ab[0] + ab[1] * ab[1];
    const t = L2 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1]) / L2)) : 0;
    return len([ap[0] - t * ab[0], ap[1] - t * ab[1]]);
  }
  function segsCross(a, b, c, d) {
    const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
  }
  function inPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const edges = (pts, closed) => {
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) out.push([pts[i], pts[i + 1]]);
    if (closed && pts.length > 2) out.push([pts[pts.length - 1], pts[0]]);
    return out;
  };
  /** 점 → 형상 거리. shape: {kind:'point'|'line'|'poly', pts:[[x,y]...]} */
  function distPtShape(p, s) {
    if (s.kind === 'point') return len(sub(p, s.pts[0]));
    if (s.kind === 'poly' && inPoly(p, s.pts)) return 0;
    let best = Infinity;
    for (const [a, b] of edges(s.pts, s.kind === 'poly')) best = Math.min(best, ptSeg(p, a, b));
    return best;
  }
  /** 형상 ↔ 형상 거리 */
  function distShapes(A, B) {
    if (A.kind === 'point') return distPtShape(A.pts[0], B);
    if (B.kind === 'point') return distPtShape(B.pts[0], A);
    if (B.kind === 'poly' && A.pts.some(p => inPoly(p, B.pts))) return 0;
    if (A.kind === 'poly' && B.pts.some(p => inPoly(p, A.pts))) return 0;
    const eA = edges(A.pts, A.kind === 'poly'), eB = edges(B.pts, B.kind === 'poly');
    for (const [a, b] of eA) for (const [c, d] of eB) if (segsCross(a, b, c, d)) return 0;
    let best = Infinity;
    for (const p of A.pts) best = Math.min(best, distPtShape(p, B));
    for (const p of B.pts) best = Math.min(best, distPtShape(p, A));
    return best;
  }

  /**
   * 기준 형상 ref: {kind:'point'|'area'|'route', pts:[{lat,lon}...], buffer(NM)}
   * NOTAM 형상과의 최소 거리(NM)와 근거. 반환 {distNm, basis:'inside'|'geometry'|'qcircle'|'wide'|null, center:[lat,lon]}
   */
  function relation(n, ref) {
    const c0 = ref.pts.reduce((a, p) => [a[0] + p.lat / ref.pts.length, a[1] + p.lon / ref.pts.length], [0, 0]);
    const P = projector(c0[0], c0[1]);
    const R = { kind: ref.kind === 'area' ? 'poly' : ref.kind === 'route' ? 'line' : 'point', pts: ref.pts.map(p => P([p.lat, p.lon])) };
    let best = Infinity, center = null;
    for (const g of n.geoms) {
      let d;
      if (g.kind === 'polygon') d = distShapes(R, { kind: 'poly', pts: g.pts.map(P) });
      else if (g.kind === 'line') d = distShapes(R, { kind: 'line', pts: g.pts.map(P) });
      else if (g.kind === 'circle') d = Math.max(0, distPtShape(P(g.center), R) - g.radiusNm);
      else d = distPtShape(P(g.center), R);
      if (d < best) { best = d; center = g.center || g.pts[0]; }
    }
    if (center) return { distNm: best, basis: best === 0 ? 'inside' : 'geometry', center };
    if (n.q) {
      const qr = n.q.radiusNm == null ? 0 : n.q.radiusNm;
      if (qr >= 999) return { distNm: null, basis: 'wide', center: [n.q.lat, n.q.lon] };
      const d = Math.max(0, distPtShape(P([n.q.lat, n.q.lon]), R) - qr);
      return { distNm: d, basis: qr >= 50 ? 'wide' : 'qcircle', center: [n.q.lat, n.q.lon] };
    }
    return { distNm: null, basis: null, center: null };
  }

  // ───────── D항목 운용 시간대 ─────────
  const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const WD = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
  const hm = s => +s.slice(0, 2) * 60 + +s.slice(2);

  /**
   * D항목 → 규칙 목록. 해석 불가 시 null.
   * 지원: "0000-0900", "DAILY 2300-0600", "H24", "MON-FRI 0000-0800", "EXC SAT SUN",
   *       "OCT 01-31 0000-0200 0430-1459, NOV 01-30 ...", "12-13 20 0640-0740", "19 2300-20 0100"
   */
  function parseSchedule(d) {
    if (!d) return null;
    const t = String(d).toUpperCase().replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
    const re = /(\d{2}) (\d{4})-(\d{2}) (\d{4})|(\d{4})-(\d{4})|(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)|(MON|TUE|WED|THU|FRI|SAT|SUN)(?:-(MON|TUE|WED|THU|FRI|SAT|SUN))?|(\d{1,2})-(\d{1,2})(?!\d)|(\d{1,2})(?!\d)|(H24)|(DAILY|DLY|AND|TO)|(EXC)|(\S+)/g;
    const groups = [], spans = [], exc = { wd: new Set(), days: [] };
    let month = null, sel = [], times = [], excMode = false, m;
    const flush = () => { if (times.length) { groups.push({ sel, times }); sel = []; times = []; } };
    while ((m = re.exec(t)) !== null) {
      if (m[1]) { // 날짜 걸침 "19 2300-20 0100"
        flush();
        spans.push({ month, d1: +m[1], t1: hm(m[2]), d2: +m[3], t2: hm(m[4]) });
      } else if (m[5]) {
        if (excMode) return null;
        const a = hm(m[5]), b = hm(m[6]);
        if (a > 1440 || b > 1440) return null;
        times.push([a, b <= a ? b + 1440 : b]);
      } else if (m[7]) { flush(); month = MON[m[7]]; }
      else if (m[8]) {
        const a = WD[m[8]], b = m[9] ? WD[m[9]] : a, set = new Set();
        for (let i = a; ; i = (i + 1) % 7) { set.add(i); if (i === b) break; }
        if (excMode) set.forEach(x => exc.wd.add(x)); else { if (times.length) flush(); sel.push({ wd: set }); }
      } else if (m[10]) {
        const s = { month, d1: +m[10], d2: +m[11] };
        if (excMode) exc.days.push(s); else { if (times.length) flush(); sel.push(s); }
      } else if (m[12]) {
        const s = { month, d1: +m[12], d2: +m[12] };
        if (excMode) exc.days.push(s); else { if (times.length) flush(); sel.push(s); }
      } else if (m[13]) { times.push([0, 1440]); }
      else if (m[14]) { /* 무시 */ }
      else if (m[15]) { flush(); excMode = true; }
      else return null; // SR, SS 등 해석 불가
    }
    flush();
    if (sel.length) return null; // 시간 없이 끝난 날짜 선택자
    if (!groups.length && !spans.length) return null;
    return { groups, spans, exc };
  }

  const selMatch = (s, dt) => {
    if (s.wd) return s.wd.has(dt.getUTCDay());
    if (s.month != null && s.month !== dt.getUTCMonth()) return false;
    const day = dt.getUTCDate();
    return s.d1 <= s.d2 ? day >= s.d1 && day <= s.d2 : day >= s.d1 || day <= s.d2;
  };

  /** [from, to] 구간에서 NOTAM이 실제로 운용되는 시간 구간 목록 [[ms, ms]...]. D항목 없으면 B~C 전체. 해석 불가 시 null */
  function activeIntervals(n, from, to) {
    const B = n.start ? n.start.getTime() : -Infinity, C = n.end ? n.end.getTime() : Infinity;
    const lo = Math.max(B, from), hi = Math.min(C, to);
    if (lo >= hi) return [];
    if (!n.schedule) return [[lo, hi]];
    const S = n._sched !== undefined ? n._sched : (n._sched = parseSchedule(n.schedule));
    if (!S) return null;
    const out = [];
    const d0 = Math.floor(lo / DAY) * DAY - DAY, d1 = Math.min(hi, d0 + 400 * DAY);
    for (let d = d0; d <= d1; d += DAY) {
      const dt = new Date(d);
      if (S.exc.wd.has(dt.getUTCDay()) || S.exc.days.some(s => selMatch(s, dt))) continue;
      for (const g of S.groups) {
        if (g.sel.length && !g.sel.some(s => selMatch(s, dt))) continue;
        for (const [a, b] of g.times) out.push([d + a * 6e4, d + b * 6e4]);
      }
    }
    // 날짜 걸침: 월이 없으면 B~C 사이 각 월에 대해 생성
    for (const sp of S.spans) {
      for (let d = Date.UTC(new Date(d0).getUTCFullYear(), new Date(d0).getUTCMonth() - 1, 1); d <= d1 + 31 * DAY;) {
        const dt = new Date(d), y = dt.getUTCFullYear(), mo = dt.getUTCMonth();
        if (sp.month == null || sp.month === mo) {
          const s = Date.UTC(y, mo, sp.d1) + sp.t1 * 6e4;
          let e = Date.UTC(y, mo, sp.d2) + sp.t2 * 6e4;
          if (e <= s) e = Date.UTC(y, mo + 1, sp.d2) + sp.t2 * 6e4;
          out.push([s, e]);
        }
        d = Date.UTC(y, mo + 1, 1);
      }
    }
    return out.map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)]).filter(([a, b]) => a < b).sort((x, y) => x[0] - y[0]);
  }

  // ───────── 고도 ─────────
  /** F/G 값 → ft. agl:true 표시. UNL → Infinity. 해석 불가 null */
  function parseAlt(s) {
    if (!s) return null;
    const t = String(s).toUpperCase().replace(/\s+/g, '');
    if (/^(SFC|GND)/.test(t)) return { ft: 0, agl: false };
    if (/^UNL/.test(t)) return { ft: Infinity, agl: false };
    let m = t.match(/^FL(\d{2,3})/);
    if (m) return { ft: +m[1] * 100, agl: false };
    m = t.match(/^(\d+(?:\.\d+)?)(FT|M)(AGL|AMSL|MSL)?/);
    if (m) return { ft: m[2] === 'M' ? +m[1] * 3.28084 : +m[1], agl: m[3] === 'AGL' };
    return null;
  }
  /** NOTAM 고도 범위 [하한, 상한] ft AMSL (AGL 상한은 terrainFt를 더해 보수적으로) */
  function altRange(n, terrainFt) {
    let lo = parseAlt(n.lower), hi = parseAlt(n.upper);
    let agl = false;
    let L = lo ? lo.ft : null, H = hi ? hi.ft : null;
    if (hi && hi.agl) { H += terrainFt || 0; agl = true; }
    if (lo && lo.agl) agl = true; // AGL 하한은 그대로(지형만큼 높을 수 있으나 보수적으로 낮게)
    if (L == null && n.lowerFL != null) L = n.lowerFL * 100;
    if (H == null && n.upperFL != null) H = n.upperFL >= 999 ? Infinity : n.upperFL * 100;
    if (L == null) L = 0;
    if (H == null) H = Infinity;
    return { lo: L, hi: H, agl };
  }

  // ───────── Q코드 분류 ─────────
  const Q2 = {
    AA: '최저고도', AC: '관제권', AD: '방공식별구역', AE: '관제구역', AF: 'FIR', AH: '상층관제구역', AL: '최저사용FL',
    AN: 'RNAV 항로', AO: '해양관제구역', AP: '보고지점', AR: 'ATS 항로', AT: '접근관제구역(TMA)', AU: 'UIR', AV: '상층조언구역',
    AX: '교차점', AZ: '비행장교통구역(ATZ)',
    CA: '공지통신', CB: 'ADS-B', CC: 'ADS-C', CD: 'CPDLC', CE: '항로감시레이더', CG: 'GCA', CL: 'SELCAL', CM: '지상감시레이더',
    CP: '정밀접근레이더(PAR)', CR: 'PAR 감시요소', CS: 'SSR', CT: '터미널감시레이더', CX: '통신·감시(기타)',
    FA: '비행장', FB: '제동상태', FC: '운고측정', FD: '주기유도', FF: '소방구조', FG: '지상이동관제', FH: '헬기착륙구역',
    FI: '제빙', FL: '착륙방향지시', FM: '기상업무', FP: '헬기장', FS: '제설', FT: '시정계', FU: '연료', FW: '풍향지시기', FZ: '세관',
    GA: 'GNSS(비행장)', GW: 'GNSS(광역)',
    IC: 'ILS', ID: 'ILS DME', IG: '활공각(GP)', II: '내측마커', IL: '로컬라이저', IM: '중간마커', IN: '로컬라이저(단독)',
    IO: '외측마커', IS: 'ILS CAT I', IT: 'ILS CAT II', IU: 'ILS CAT III', IW: 'MLS', IX: '외측로케이터', IY: '중간로케이터',
    LA: '접근등', LB: '비행장등대', LC: '활주로중심선등', LD: '착륙방향지시등', LE: '활주로등', LF: '순차섬광등', LG: '조종사제어등화',
    LH: '고광도활주로등', LI: '활주로말단식별등', LJ: '활주로정렬등', LK: 'CAT II 접근등', LL: '저광도활주로등', LM: '중광도활주로등',
    LP: 'PAPI', LR: '착륙지역등화', LS: '정지로등', LT: '시단등', LU: '헬기접근경로지시등', LV: 'VASIS', LW: '헬기장등화',
    LX: '유도로중심선등', LY: '유도로등', LZ: '접지구역등',
    MA: '이동지역', MB: '포장강도', MC: '개방구역', MD: '공시거리', MG: '유도안내시스템', MH: '활주로제동장치', MK: '주기지역',
    MM: '주간표지', MN: '계류장', MO: '정지선', MP: '주기장', MR: '활주로', MS: '정지로', MT: '활주로시단', MU: '활주로회전구역',
    MW: '착륙대·갓길', MX: '유도로', MY: '고속탈출유도로',
    NA: '항행안전시설', NB: 'NDB', ND: 'DME', NF: '팬마커', NL: '로케이터', NM: 'VOR/DME', NN: 'TACAN', NT: 'VORTAC', NV: 'VOR', NX: '방향탐지기',
    OA: '항공정보업무', OB: '장애물', OE: '입국요건', OL: '장애물등', OR: '구조조정본부', OS: '장애물(기타)',
    PA: 'STAR', PB: '표준 VFR 도착', PC: '비상절차', PD: 'SID', PE: '표준 VFR 출발', PF: '교통흐름관리', PH: '체공',
    PI: '계기접근절차', PK: 'VFR 접근절차', PL: '비행계획', PM: '비행장운영최저치', PN: '소음절차', PO: '장애물회피고도',
    PR: '무선고장절차', PT: '전이고도', PU: '실패접근절차', PX: '최저체공고도', PZ: 'ADIZ 절차',
    RA: '공역예약', RD: '위험구역', RM: '군작전구역', RO: '상공비행', RP: '금지구역', RR: '제한구역', RT: '임시제한구역',
    SA: 'ATIS', SB: 'ATS 보고소', SC: '지역관제소', SE: '비행정보센터', SF: '비행장정보업무', SL: '흐름관리센터', SO: '해양관제소',
    SP: '접근관제', SS: '비행업무국', ST: '관제탑', SU: '상층관제소', SV: 'VOLMET', SY: '상층조언업무',
    WA: '에어쇼', WB: '곡예비행', WC: '계류기구·연', WD: '폭발물처리', WE: '훈련', WF: '공중급유', WG: '활공비행', WH: '발파',
    WJ: '배너·표적예인', WL: '자유기구', WM: '미사일·사격', WP: '낙하산강하', WR: '방사성물질', WS: '가스배출', WT: '대규모비행',
    WU: '무인기', WV: '편대비행', WW: '화산활동', WY: '항공측량', WZ: '모형항공기', KK: '체크리스트'
  };
  /** XX(평문)일 때 본문 키워드로 추정 */
  const KW = [
    [/\bDRONE|UAS|UAV|UNMANNED/, '무인기'], [/\bFIRING|GUN|MISSILE|ROCKET/, '사격'], [/\bPARACHUT/, '낙하산강하'],
    [/\bRWY\b.*\bCLSD/, '활주로'], [/\bTWY\b/, '유도로'], [/\bAPRON|\bSTAND/, '계류장'], [/\bCRANE|OBST/, '장애물'],
    [/\bVOR\b|VORTAC|DME|TACAN|NDB/, '항행안전시설'], [/\bILS|LOC\b|GP\b|GLIDE ?SLOPE/, 'ILS'],
    [/WIND DIRECTION/, '풍향지시기'], [/PARKING|RAMP|SPOTS?\b/, '계류장'], [/MARKING/, '표지'],
    [/PERSONNEL AND EQUIPMENT|MEN (&|AND) EQUIP|EQUIPMENT STAGED|TRENCH|MANHOLE|\bCONST/, '공사·작업'],
    [/\bDEPARTURE/, '출발절차'], [/APPROACH/, '접근'], [/WEATHER|\bWX\b/, '기상'], [/STOVL|TOWING|TRANSIENT|SECURITY|AERODROME/, '비행장'], [/\bRADAR/, '레이더'],
    [/\bLGT|LIGHT/, '등화'], [/\bATIS|FREQ|MHZ/, '통신'], [/\bAIP|AIRAC/, '항공정보'], [/\bBIRD/, '조류'],
    [/\bFUEL/, '연료'], [/\bEXER|TRAINING/, '훈련'], [/\bBALLOON/, '기구'], [/\bLASER/, '레이저']
  ];
  function category(n) {
    const q = n.qcode || '';
    const k = q.slice(1, 3);
    if (Q2[k]) return Q2[k];
    const txt = (n.text || '').toUpperCase();
    for (const [re, name] of KW) if (re.test(txt)) return name;
    const first = { A: '공역', C: '통신·감시', F: '비행장시설', G: 'GNSS', I: '계기착륙', L: '등화', M: '이동지역',
      N: '항행안전시설', O: '기타정보', P: '절차', R: '공역제한', S: '항공교통업무', W: '항행경고' }[q[1]];
    return first || '기타';
  }

  // ───────── 목록 판정 ─────────
  const keyOf = n => (n.id || n.raw.slice(0, 40)) + '|' + ((n.locations && n.locations[0]) || '');

  /**
   * opts: { ref, from, to, altLo, altHi, terrainFt }
   * 반환 [{n, rel, intervals, schedKnown, inWindow, altOk, alt, key}]
   */
  function evaluate(list, opts) {
    const cancelled = new Set(list.filter(n => n.type === 'NOTAMC' && n.refId).map(n => n.refId));
    const replaced = new Set(list.filter(n => n.type === 'NOTAMR' && n.refId).map(n => n.refId));
    const out = [], seen = new Set();
    for (const n of list) {
      if (n.type === 'NOTAMC') continue;
      if (n.id && (cancelled.has(n.id) || replaced.has(n.id))) continue;
      const key = keyOf(n);
      if (seen.has(key)) continue;
      seen.add(key);
      const B = n.start ? n.start.getTime() : -Infinity, C = n.end ? n.end.getTime() : Infinity;
      if (B > opts.to || C < opts.from) continue;
      const rel = relation(n, opts.ref);
      if (rel.basis !== 'wide' && (rel.distNm == null || rel.distNm > opts.ref.buffer)) continue;
      const iv = activeIntervals(n, opts.from, opts.to);
      const alt = altRange(n, opts.terrainFt);
      const altOk = !(alt.lo > opts.altHi || alt.hi < opts.altLo);
      out.push({ n, key, rel, intervals: iv, schedKnown: iv !== null, inWindow: iv === null ? null : iv.length > 0, altOk, alt });
    }
    out.sort((a, b) => {
      const ia = a.rel.basis === 'inside' ? 0 : 1, ib = b.rel.basis === 'inside' ? 0 : 1;
      if (ia !== ib) return ia - ib;
      return (a.rel.distNm == null ? 1e9 : a.rel.distNm) - (b.rel.distNm == null ? 1e9 : b.rel.distNm);
    });
    return out;
  }

  /** 지금 운용 중인지와 다음 운용 시작 (B~C 기준, 7일 앞까지) */
  function nowState(n, now) {
    const iv = activeIntervals(n, now, now + 7 * DAY);
    if (iv === null) return { known: false };
    const cur = iv.find(([a, b]) => a <= now && b > now);
    if (cur) {
      // D항목 없으면 종료는 C) 그대로(PERM이면 Infinity)
      const C = n.end ? n.end.getTime() : Infinity;
      return { known: true, active: true, until: n.schedule ? cur[1] : C };
    }
    return { known: true, active: false, next: iv[0] || null };
  }

  // ───────── 고정 공역·항로(eAIP) 근접 판정 ─────────
  const TYPE_ORDER = { P: 0, R: 1, D: 2, MOA: 3, UA: 4, CATA: 5, ROUTE: 6, TMA: 7 };
  const bandOverlap = (lo, hi, aLo, aHi) => !(lo > aHi || hi < aLo);
  /**
   * aip: parse-aip.mjs 결과. opts: {ref, altLo, altHi, terrainFt}
   * 반환 [{kind:'airspace'|'route', type, id, name, distNm, inside, lo, hi, altOk(true/false/null), item, seg}]
   */
  function aipConflicts(aip, opts) {
    const out = [], ref = opts.ref, T = opts.terrainFt || 0;
    const ftOf = (v, isUpper) => {
      if (!v) return null;
      if (v.unl) return Infinity;
      return v.ft + (isUpper && v.agl ? T : 0);
    };
    for (const a of aip.airspaces || []) {
      const rel = relation({ geoms: a.geoms }, ref);
      if (rel.distNm == null || rel.distNm > ref.buffer) continue;
      const lo = ftOf(a.lower, false), hi = ftOf(a.upper, true);
      const altOk = lo == null || hi == null ? null : bandOverlap(lo, hi, opts.altLo, opts.altHi);
      out.push({ kind: 'airspace', type: a.type, id: a.id, name: a.name, distNm: rel.distNm, inside: rel.distNm === 0, lo, hi, altOk, item: a });
    }
    for (const r of aip.routes || []) {
      let best = null;
      for (const sg of r.segs) {
        const a = r.points[sg.from], b = r.points[sg.to];
        const rel = relation({ geoms: [{ kind: 'line', pts: [[a.lat, a.lon], [b.lat, b.lon]] }] }, ref);
        if (rel.distNm == null || rel.distNm > ref.buffer) continue;
        if (!best || rel.distNm < best.distNm) best = { distNm: rel.distNm, seg: sg };
      }
      if (!best) continue;
      const sg = best.seg;
      const lo = sg.meaFt != null ? sg.meaFt : sg.lowerFt != null ? sg.lowerFt : 0;
      const hi = sg.upperFt != null ? sg.upperFt : Infinity;
      out.push({ kind: 'route', type: 'ROUTE', id: r.id, name: `${r.id} ${r.spec || ''}`.trim(), distNm: best.distNm, inside: best.distNm === 0,
        lo, hi, altOk: bandOverlap(lo, hi, opts.altLo, opts.altHi), item: r, seg: sg });
    }
    out.sort((x, y) => (TYPE_ORDER[x.type] - TYPE_ORDER[y.type]) || (x.distNm - y.distNm));
    return out;
  }

  const api = { aipConflicts, AIRPORTS, parsePoint, parsePointList, relation, parseSchedule, activeIntervals, parseAlt, altRange,
    category, evaluate, nowState, keyOf, distShapes, projector };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NEAR = api;
})(typeof self !== 'undefined' ? self : this);
