// 새 NOTAM 푸시 알림: 직전 수집본(prev)과 이번 수집본(cur)을 비교해, 등록된 기준 근처의 새 NOTAM을 알림으로 보냄.
// 사용: node scripts/notify.mjs prev.json cur.json
// 환경변수: PUSH_TARGETS (앱 '🔔 새 NOTAM 알림'에서 만든 등록 정보 1개 또는 배열), VAPID_PRIVATE_KEY
// web-push 패키지가 필요 (워크플로에서 설치)
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const N = require('../notam.js');
globalThis.NOTAM = N;
const C = require('../nearby-core.js');

export const VAPID_PUBLIC = 'BAD9VkAR9bCqI_1ssG26vBTq5G4qvh5gfQvUN70rpbKELZG3bid5gG3CsBB01m0A-EpKFjr7HxEpdfzb57w-xno';

const pad = n => String(n).padStart(2, '0');
const kst = ms => { const d = new Date(ms + 9 * 3600e3); return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };

/** 대상 하나에 대해 새 NOTAM 중 기준 근처(7일 내 유효)인 것 → 알림 내용. 없으면 null */
export function buildMessage(target, prevRaws, curRaws, now = Date.now()) {
  const prevKeys = new Set(prevRaws.map(r => C.keyOf(N.parseNotam(r))));
  const fresh = curRaws.map(r => N.parseNotam(r)).filter(n => !prevKeys.has(C.keyOf(n)));
  if (!fresh.length) return null;
  const hits = [];
  for (const ref of target.refs || []) {
    const r = Object.assign({ buffer: 10 }, ref);
    const res = C.evaluate(fresh, { ref: r, from: now, to: now + 7 * 864e5, altLo: -Infinity, altHi: Infinity, terrainFt: 0 })
      .filter(x => x.rel.basis !== 'wide' && x.inWindow !== false);
    for (const x of res) if (!hits.some(h => h.x.key === x.key)) hits.push({ x, ref: r });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => (a.x.rel.distNm || 0) - (b.x.rel.distNm || 0));
  const names = [...new Set(hits.map(h => h.ref.name || '기준'))];
  const lines = hits.slice(0, 3).map(({ x, ref }) => {
    const n = x.n, B = n.start ? n.start.getTime() : null;
    const where = x.rel.basis === 'inside' ? '겹침' : x.rel.distNm === 0 ? '범위 안' : `${x.rel.distNm.toFixed(1)}NM`;
    return `${C.category(n)} ${n.id || ''} · ${ref.name || ''} ${where}${B ? ' · ' + kst(B) + ' KST~' : ''}`;
  });
  if (hits.length > 3) lines.push(`외 ${hits.length - 3}건`);
  return { title: `새 NOTAM ${hits.length}건 — ${names.join(', ')}`, body: lines.join('\n'), tag: 'notam-new' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [prevFile, curFile] = process.argv.slice(2);
  const raw = process.env.PUSH_TARGETS, priv = process.env.VAPID_PRIVATE_KEY;
  if (!raw || !priv) { console.log('PUSH_TARGETS 또는 VAPID_PRIVATE_KEY가 없어 알림을 건너뜁니다.'); process.exit(0); }
  if (!prevFile || !existsSync(prevFile)) { console.log('직전 수집본이 없어 비교를 건너뜁니다(첫 실행).'); process.exit(0); }
  let targets;
  try { targets = JSON.parse(raw); } catch (e) { console.error('PUSH_TARGETS JSON 형식 오류:', e.message); process.exit(1); }
  if (!Array.isArray(targets)) targets = [targets];
  const prev = JSON.parse(readFileSync(prevFile, 'utf8')).notams || [];
  const cur = JSON.parse(readFileSync(curFile, 'utf8')).notams || [];
  const webpush = require('web-push');
  webpush.setVapidDetails('https://github.com/notam-traffic', VAPID_PUBLIC, priv);
  let sent = 0;
  for (const [i, t] of targets.entries()) {
    const msg = buildMessage(t, prev, cur);
    if (!msg) { console.log(`대상 ${i + 1}: 새 NOTAM 없음`); continue; }
    try {
      await webpush.sendNotification(t.sub, JSON.stringify(msg), { TTL: 6 * 3600, urgency: 'high' });
      sent++; console.log(`대상 ${i + 1}: 알림 보냄 — ${msg.title}`);
    } catch (e) {
      console.error(`대상 ${i + 1}: 전송 실패 ${e.statusCode || ''} ${e.statusCode === 404 || e.statusCode === 410 ? '(구독 만료 — 앱에서 다시 등록 필요)' : e.message}`);
    }
  }
  console.log(`알림 ${sent}건 전송`);
}
