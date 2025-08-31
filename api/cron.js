// api/cron.js
export default async function handler(req, res) {
  // 允許 GET/HEAD 作為 Cron 呼叫方式
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).end('Method Not Allowed');
  }

  // 取得 Authorization（同時支援 req.headers.get 與物件存取）
  const headerGetter = req.headers?.get ? (n) => req.headers.get(n) : (n) => req.headers?.[n];
  const auth = (headerGetter('authorization') || '').toString();

  // 你的授權檢查（有設 CRON_SECRET 才會檢查）
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end('Unauthorized');
  }

  // （可選）保活：若有設定 CRON_PING_URL 就打個 HEAD
  try {
    const url = process.env.CRON_PING_URL || '';
    if (url) {
      await fetch(url, { method: 'HEAD' }).catch(() => {});
    }
  } catch (_) {}

  return res.status(200).json({ ok: true });
}
