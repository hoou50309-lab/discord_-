// api/cron.js — 強化版健康/排程端點（相容性調整版）
// - 允許 GET / HEAD
// - 金鑰保護：支援 Authorization: Bearer <CRON_SECRET>，或 x-admin-key / ?key=<ADMIN_KEY>
// - 回傳 JSON（HEAD 無 body）
// - 可選：CRON_PING_URL（HEAD）
// - 內建 Upstash Redis PING 以做連線自檢
// - 相容性：移除 .catch() 鏈式與可選鏈接，避免某些編譯/ESM 解析器誤判

export const dynamic = 'force-dynamic';

function getHeader(req, name) {
  try {
    if (req && req.headers) {
      if (typeof req.headers.get === 'function') {
        const v = req.headers.get(name);
        return v == null ? '' : String(v);
      }
      const lower = String(name).toLowerCase();
      const v = req.headers[name] || req.headers[lower];
      return v == null ? '' : String(v);
    }
  } catch (e) {}
  return '';
}

function getQuery(req, key) {
  try {
    if (req && req.query) {
      const v = req.query[key] || req.query[String(key).toUpperCase()];
      return v == null ? '' : String(v);
    }
  } catch (e) {}
  return '';
}

function isAuthorized(req) {
  const hasCron = !!process.env.CRON_SECRET;
  const hasAdmin = !!process.env.ADMIN_KEY;

  const bearer = getHeader(req, 'authorization');
  const bearerOk = hasCron && bearer === 'Bearer ' + process.env.CRON_SECRET;

  const adminKey = process.env.ADMIN_KEY || '';
  const headerKeyOk = hasAdmin && getHeader(req, 'x-admin-key') === adminKey;
  const queryKeyOk  = hasAdmin && getQuery(req, 'key') === adminKey;

  if (hasCron || hasAdmin) return !!(bearerOk || headerKeyOk || queryKeyOk);
  return false; // 預設拒絕
}

export default async function handler(req, res) {
  // 基本安全標頭/不可快取
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex');

  // 僅允許 GET/HEAD
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).end('Method Not Allowed');
    return;
  }

  // 金鑰保護
  if (!isAuthorized(req)) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return;
  }

  // 可選：對外 ping 一下（例如喚醒某服務）
  try {
    const url = process.env.CRON_PING_URL || '';
    if (url) {
      try { await fetch(url, { method: 'HEAD', cache: 'no-store' }); } catch (e) {}
    }
  } catch (e) {}

  // 可選：Upstash Redis 健檢
  let redis = 'disabled';
  try {
    const RURL = process.env.UPSTASH_REDIS_REST_URL || '';
    const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || '';
    if (RURL && RTOK) {
      const r = await fetch(RURL + '/PING', {
        headers: { Authorization: 'Bearer ' + RTOK },
        cache: 'no-store',
      });
      let j = null;
      try { j = await r.json(); } catch (e) {}
      redis = j && j.result ? j.result : 'unknown';
    }
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    redis = 'error: ' + msg;
  }

  if (req.method === 'HEAD') { res.status(200).end(); return; }
  res.status(200).json({ ok: true, ts: Date.now(), redis });
}
