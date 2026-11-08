/* notam.js — ICAO NOTAM 파서 + 시간창/지역 필터 (브라우저·Node 공용) */
(function (root) {
  'use strict';

  const NM_PER_KM = 1 / 1.852;
  const R_NM = 3440.065; // 지구 반지름 [NM]

  function toRad(d) { return d * Math.PI / 180; }
  function toDeg(r) { return r * 180 / Math.PI; }

  /** 두 점 사이 거리 [NM] (대권) */
  function distNm(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** 방위각 [deg, 진북 기준] */
  function bearingDeg(lat1, lon1, lat2, lon2) {
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  /** YYMMDDhhmm (UTC) → Date */
  function parseNotamTime(s) {
    if (!s) return null;
    const m = String(s).match(/(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!m) return null;
    return new Date(Date.UTC(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  }

  /** Q) 라인 좌표 "3702N12727E005" → {lat, lon, radiusNm} */
  function parseQCoord(s) {
    const m = String(s).match(/(\d{2})(\d{2})([NS])(\d{3})(\d{2})([EW])(\d{3})?/);
    if (!m) return null;
    let lat = +m[1] + +m[2] / 60, lon = +m[4] + +m[5] / 60;
    if (m[3] === 'S') lat = -lat;
    if (m[6] === 'W') lon = -lon;
    return { lat, lon, radiusNm: m[7] ? +m[7] : null };
  }

  /** 본문(E) 좌표 추출: 370003N1262713E, 370003.5N1262713.2E, 3700N12700E */
  const COORD_RE = /(\d{2})(\d{2})(\d{2}(?:\.\d+)?)?\s?([NS])\s?(\d{3})(\d{2})(\d{2}(?:\.\d+)?)?\s?([EW])/g;
  function extractCoords(text) {
    const pts = [];
    if (!text) return pts;
    let m;
    COORD_RE.lastIndex = 0;
    while ((m = COORD_RE.exec(text)) !== null) {
      let lat = +m[1] + +m[2] / 60 + (m[3] ? +m[3] / 3600 : 0);
      let lon = +m[5] + +m[6] / 60 + (m[7] ? +m[7] / 3600 : 0);
      if (m[4] === 'S') lat = -lat;
      if (m[8] === 'W') lon = -lon;
      if (lat <= 90 && lon <= 180) pts.push([lat, lon]);
    }
    return pts;
  }

  /** 반경 표현 → NM ("RADIUS 5NM", "RADIUS OF 2KM", "500M RADIUS") */
  function extractRadiusNm(text) {
    if (!text) return null;
    const m = text.match(/RADIUS(?:\s+OF)?\s+(\d+(?:\.\d+)?)\s*(NM|KM|M)\b/) ||
      text.match(/(\d+(?:\.\d+)?)\s*(NM|KM|M)\s+RADIUS/);
    if (!m) return null;
    const v = +m[1];
    if (m[2] === 'NM') return v;
    if (m[2] === 'KM') return v * NM_PER_KM;
    return v / 1000 * NM_PER_KM;
  }

  /**
   * 원문 NOTAM 한 건 파싱.
   * 반환: { id, type, qcode, fir, q:{lat,lon,radiusNm}, lowerFL, upperFL, locations[], start, end,
   *        perm, est, schedule, text, lower, upper, geoms:[{kind:'polygon',pts}|{kind:'circle',center,radiusNm}], raw }
   */
  function parseNotam(raw) {
    const t = String(raw).replace(/\r/g, '').trim();
    const flat = t.replace(/\s*\n\s*/g, ' ');
    const n = { raw: t, geoms: [] };

    const head = flat.match(/\b([A-Z]\d{4}\/\d{2})\s+(NOTAM[NRC])(?:\s+([A-Z]\d{4}\/\d{2}))?/);
    if (head) { n.id = head[1]; n.type = head[2]; n.refId = head[3] || null; }

    // 항목 분리: " Q) ", " A) " ...
    const items = {};
    const re = /(?:^|\s)([QABCDEFG])\)\s*/g;
    const marks = [];
    let m;
    while ((m = re.exec(flat)) !== null) marks.push({ k: m[1], i: m.index, j: re.lastIndex });
    for (let x = 0; x < marks.length; x++) {
      const end = x + 1 < marks.length ? marks[x + 1].i : flat.length;
      if (!(marks[x].k in items)) items[marks[x].k] = flat.slice(marks[x].j, end).trim();
    }
    // E는 원래 줄바꿈 유지본도 보관
    const eIdx = t.search(/(?:^|\s)E\)\s*/);
    if (eIdx >= 0) {
      let eTxt = t.slice(eIdx).replace(/^\s*E\)\s*/, '');
      const fIdx = eTxt.search(/(?:^|\s)[FG]\)\s/);
      if (fIdx >= 0) eTxt = eTxt.slice(0, fIdx);
      n.text = eTxt.trim();
    } else {
      n.text = items.E || flat;
    }

    if (items.Q) {
      const parts = items.Q.split('/').map(s => s.trim());
      n.fir = parts[0] || null;
      n.qcode = parts[1] || null;
      n.lowerFL = parts[5] != null && /^\d{3}$/.test(parts[5]) ? +parts[5] : null;
      n.upperFL = parts[6] != null && /^\d{3}$/.test(parts[6]) ? +parts[6] : null;
      n.q = parseQCoord(parts[7] || items.Q);
    }
    n.locations = items.A ? items.A.split(/\s+/).filter(Boolean) : [];
    n.start = parseNotamTime(items.B);
    if (items.C) {
      n.perm = /PERM/.test(items.C);
      n.est = /EST/.test(items.C);
      n.end = n.perm ? null : parseNotamTime(items.C);
    } else {
      n.end = null;
    }
    n.schedule = items.D || null;
    n.lower = items.F || null;
    n.upper = items.G || null;

    // 형상 추출
    const pts = extractCoords(n.text);
    const rad = extractRadiusNm(n.text);
    if (pts.length >= 3) {
      // 닫힌 다각형(첫점=끝점) 중복 제거
      const last = pts[pts.length - 1];
      if (Math.abs(last[0] - pts[0][0]) < 1e-6 && Math.abs(last[1] - pts[0][1]) < 1e-6) pts.pop();
      n.geoms.push({ kind: 'polygon', pts });
    } else if (pts.length >= 1 && rad) {
      n.geoms.push({ kind: 'circle', center: pts[0], radiusNm: rad });
    } else if (pts.length >= 1) {
      pts.forEach(p => n.geoms.push({ kind: 'point', center: p }));
    }
    return n;
  }

  /** 여러 건이 붙어있는 텍스트를 개별 NOTAM으로 분리 */
  function splitNotams(text) {
    const t = String(text).replace(/\r/g, '');
    const idxs = [];
    const re = /(?:^|\n|\s)\(?([A-Z]\d{4}\/\d{2})\s+NOTAM[NRC]/g;
    let m;
    while ((m = re.exec(t)) !== null) idxs.push(m.index + m[0].indexOf(m[1]));
    if (idxs.length === 0) {
      return t.split(/\n\s*\n/).map(s => s.trim()).filter(s => /Q\)|E\)/.test(s));
    }
    const out = [];
    for (let i = 0; i < idxs.length; i++) {
      out.push(t.slice(idxs[i], i + 1 < idxs.length ? idxs[i + 1] : t.length).trim().replace(/\)\s*$/, ''));
    }
    return out;
  }

  function pointInPolygon(lat, lon, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const yi = pts[i][0], xi = pts[i][1], yj = pts[j][0], xj = pts[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /** 점→선분 최소거리 [NM] (국소 평면 근사, 수십 NM 범위에서 충분) */
  function distToSegmentNm(lat, lon, a, b) {
    const k = Math.cos(toRad(lat));
    const ax = (a[1] - lon) * 60 * k, ay = (a[0] - lat) * 60;
    const bx = (b[1] - lon) * 60 * k, by = (b[0] - lat) * 60;
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    let tt = L2 ? -(ax * dx + ay * dy) / L2 : 0;
    tt = Math.max(0, Math.min(1, tt));
    const px = ax + tt * dx, py = ay + tt * dy;
    return Math.hypot(px, py);
  }

  /**
   * 지역 관련성 판정. 반환 { relevant, distNm, basis }
   * basis: 'inside' | 'geometry' | 'qcircle' | 'wide' | 'location'
   */
  function areaRelevance(n, lat, lon, radiusNm, opts) {
    opts = opts || {};
    let best = Infinity, basis = null;
    for (const g of n.geoms) {
      if (g.kind === 'polygon') {
        if (pointInPolygon(lat, lon, g.pts)) return { relevant: true, distNm: 0, basis: 'inside' };
        for (let i = 0; i < g.pts.length; i++) {
          const d = distToSegmentNm(lat, lon, g.pts[i], g.pts[(i + 1) % g.pts.length]);
          if (d < best) { best = d; basis = 'geometry'; }
        }
      } else if (g.kind === 'circle') {
        const d = Math.max(0, distNm(lat, lon, g.center[0], g.center[1]) - g.radiusNm);
        if (d === 0) return { relevant: true, distNm: 0, basis: 'inside' };
        if (d < best) { best = d; basis = 'geometry'; }
      } else if (g.kind === 'point') {
        const d = distNm(lat, lon, g.center[0], g.center[1]);
        if (d < best) { best = d; basis = 'geometry'; }
      }
    }
    if (basis) return { relevant: best <= radiusNm, distNm: best, basis };

    if (n.q) {
      const qr = n.q.radiusNm == null ? 0 : n.q.radiusNm;
      if (qr >= 999) return { relevant: !!opts.includeWide, distNm: null, basis: 'wide' };
      const d = Math.max(0, distNm(lat, lon, n.q.lat, n.q.lon) - qr);
      return { relevant: d <= radiusNm, distNm: d, basis: 'qcircle' };
    }
    // 좌표 정보가 없으면 위치지시자로만 판단
    if (opts.locations && n.locations.some(l => opts.locations.includes(l))) {
      return { relevant: true, distNm: null, basis: 'location' };
    }
    return { relevant: false, distNm: null, basis: null };
  }

  /** 시간창 판정: 'active' | 'upcoming' | 'expired' | 'overlap' */
  function timeStatus(n, winStart, winEnd) {
    const s = n.start ? n.start.getTime() : -Infinity;
    const e = n.end ? n.end.getTime() : Infinity;
    const ws = winStart.getTime(), we = winEnd.getTime();
    if (s > we) return 'after';
    if (e < ws) return 'before';
    return 'overlap';
  }

  /**
   * 목록 필터.
   * opts: { lat, lon, radiusNm, winStart, winEnd, includeWide, locations }
   */
  function filterNotams(list, opts) {
    const cancelled = new Set(list.filter(n => n.type === 'NOTAMC' && n.refId).map(n => n.refId));
    const replaced = new Set(list.filter(n => n.type === 'NOTAMR' && n.refId).map(n => n.refId));
    const out = [];
    const seen = new Set();
    for (const n of list) {
      if (n.type === 'NOTAMC') continue;
      if (n.id && (cancelled.has(n.id) || replaced.has(n.id))) continue;
      const key = n.id ? n.id + '|' + (n.locations[0] || '') : n.raw;
      if (seen.has(key)) continue;
      seen.add(key);
      const ts = timeStatus(n, opts.winStart, opts.winEnd);
      if (ts !== 'overlap') continue;
      const ar = areaRelevance(n, opts.lat, opts.lon, opts.radiusNm, opts);
      if (!ar.relevant) continue;
      out.push(Object.assign({}, n, { area: ar, schedOk: scheduleOverlap(n, opts.winStart, opts.winEnd) }));
    }
    out.sort((a, b) => {
      const sa = a.schedOk === false ? 1 : 0, sb = b.schedOk === false ? 1 : 0;
      if (sa !== sb) return sa - sb;
      const da = a.area.distNm == null ? 1e9 : a.area.distNm;
      const db = b.area.distNm == null ? 1e9 : b.area.distNm;
      return da - db;
    });
    return out;
  }

  /**
   * D) 항목이 단순 일일 시간대("0000-0900", "DAILY 2300-0600", "0100-0300 0500-0700")일 때
   * 시간창(UTC)과 겹치는지 판정. true/false, 해석 불가 시 null.
   */
  function scheduleOverlap(n, winStart, winEnd) {
    if (!n.schedule) return null;
    const s = n.schedule.replace(/\bDAILY\b|\bDLY\b|,/g, ' ').trim();
    if (!/^(\d{4}-\d{4}\s*)+$/.test(s)) return null;
    const spans = s.match(/\d{4}-\d{4}/g).map(x => {
      const [a, b] = x.split('-');
      return [(+a.slice(0, 2)) * 60 + +a.slice(2), (+b.slice(0, 2)) * 60 + +b.slice(2)];
    });
    const day0 = Date.UTC(winStart.getUTCFullYear(), winStart.getUTCMonth(), winStart.getUTCDate()) - 864e5;
    for (let d = day0; d <= winEnd.getTime(); d += 864e5) {
      for (const [a, b] of spans) {
        const st = d + a * 6e4;
        const en = d + (b > a ? b : b + 1440) * 6e4; // 자정 넘김 처리
        if (st < winEnd.getTime() && en > winStart.getTime()) return true;
      }
    }
    return false;
  }

  /** Q코드 2·3번째 글자 → 간단 분류 */
  function qCategory(qcode) {
    if (!qcode || qcode.length < 3) return '기타';
    const s = qcode.slice(1, 3);
    const map = {
      RD: '위험구역', RR: '제한구역', RP: '금지구역', RT: '임시제한구역', RA: '공역예약',
      RM: '군작전구역', AE: '관제구역', AF: 'FIR', AT: 'TMA', AC: '관제권', AR: '항로', AH: '상층관제구역',
      MR: '활주로', MX: '유도로', MA: '이동지역', FA: '비행장', OB: '장애물', OL: '장애물등',
      WU: '무인기', WE: '훈련', WM: '사격', WP: '낙하산', WL: '풍선/연', WA: '에어쇼', WB: '곡예비행',
      WF: '공중급유', WJ: '견인', WZ: '모형항공기', WV: '편대비행', WW: '중요화산활동',
      NA: '항행안전시설', NV: 'VOR', ND: 'DME', IC: 'ILS', IG: 'GP', IL: 'LOC', GA: 'GNSS', GW: 'GNSS',
      PI: '계기접근', PD: 'SID', PA: 'STAR', CA: '공지통신', CT: '감시레이더', CS: 'SSR'
    };
    return map[s] || (qcode[1] === 'W' ? '항행경고' : qcode[1] === 'R' ? '공역제한' : '기타');
  }

  /** 지오메트리 문자열(NMS GeoJSON 등)에서 NOTAM 원문 후보를 재귀로 찾아냄 */
  function findIcaoTexts(obj, out, depth) {
    out = out || []; depth = depth || 0;
    if (depth > 8 || obj == null) return out;
    if (typeof obj === 'string') {
      if (/Q\)\s*[A-Z]{4}\//.test(obj) && /E\)/.test(obj)) out.push(obj);
      return out;
    }
    if (Array.isArray(obj)) { obj.forEach(v => findIcaoTexts(v, out, depth + 1)); return out; }
    if (typeof obj === 'object') { Object.values(obj).forEach(v => findIcaoTexts(v, out, depth + 1)); }
    return out;
  }

  const api = {
    distNm, bearingDeg, parseNotamTime, parseQCoord, extractCoords, extractRadiusNm,
    parseNotam, splitNotams, pointInPolygon, areaRelevance, timeStatus, filterNotams, scheduleOverlap,
    qCategory, findIcaoTexts
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NOTAM = api;
})(typeof self !== 'undefined' ? self : this);
