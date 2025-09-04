// api/cron.js — 強化版健康/排程端點
// - 允許 GET / HEAD
// - 金鑰保護：支援 Authorization: Bearer <CRON_SECRET>，或 x-admin-key / ?key=<ADMIN_KEY>
// - 回傳 JSON（HEAD 無 body）
// - 可選：CRON_PING_URL（HEAD）
// - 內建 Upstash Redis PING 以做連線自檢

export const dynamic = 'force-dynamic';

function getHeader(req, name) {
  const h = req.headers?.get ? req.headers.get(name) : req.headers?.[name];
  return (h || '').toString();
}

function isAuthorized(req) {
  const hasCron = !!process.env.CRON_SECRET;
  const hasAdmin = !!process.env.ADMIN_KEY;

  const auth = getHeader(req, 'authorization');
  const bearerOk = hasCron && auth === `Bearer ${process.env.CRON_SECRET}`;

  const adminKey = process.env.ADMIN_KEY || '';
  const headerKeyOk = hasAdmin && getHeader(req, 'x-admin-key') === adminKey;
  const queryKey = (req.query?.key || req.query?.KEY || '').toString();
  const queryKeyOk = hasAdmin && queryKey === adminKey;

  // 若任一金鑰存在，至少命中一種才放行；都沒設則預設拒絕（更安全）
  if (hasCron || hasAdmin) return bearerOk || headerKeyOk || queryKeyOk;
  return false;
}

export default async function handler(req, res) {
  // 基本安全標頭/不可快取
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex');

  // 僅允許 GET/HEAD
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).end('Method Not Allowed');
  }

  // 金鑰保護
  if (!isAuthorized(req)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  // 可選：對外 ping 一下（例如喚醒某服務）
  try {
    const url = process.env.CRON_PING_URL || '';
    if (url) {
      await fetch(url, { method: 'HEAD', cache: 'no-store' }).catch(() => {});
    }
  } catch {}

  // 可選：Upstash Redis 健檢
  let redis = 'disabled';
  try {
    const RURL = process.env.UPSTASH_REDIS_REST_URL || '';
    const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || '';
    if (RURL && RTOK) {
      const r = await fetch(`${RURL}/PING`, {
        headers: { Authorization: `Bearer ${RTOK}` },
        cache: 'no-store',
      });
      const j = await r.json().catch(() => null);
      redis = j?.result ?? 'unknown';
    }
  } catch (e) {
    redis = `error: ${String(e?.message || e)}`;
  }

  if (req.method === 'HEAD') return res.status(200).end();
  return res.status(200).json({ ok: true, ts: Date.now(), redis });
}
