import { NextResponse } from 'next/server';
// api/cron.js
export default async function handler(req, res) {
  const auth = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end('Unauthorized');
  }

  // 做你要的定時工作，或簡單保活
  try {
    const base = process.env.CRON_PING_URL || `https://${process.env.VERCEL_URL}/api/discord`;
    await fetch(base, { method: 'HEAD' }); // 或 GET
  } catch (_) {}
  return res.status(200).json({ ok: true });
}
