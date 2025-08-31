// api/cron.js
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  // 只有 Cron 會帶這個 header；沒帶就拒絕，避免被隨便打
  const ok = req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!ok) return res.status(401).end('Unauthorized');

  // 可選：若想順便暖機 /api/discord，就在環境變數放你的外部網址
  // if (process.env.CRON_PING_URL) { try { await fetch(process.env.CRON_PING_URL, { method: 'HEAD' }); } catch {} }

  return res.status(200).json({ ok: true, t: Date.now() });
}
