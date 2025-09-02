// api/discord.js — ultra-minimal, HEAD + async verify
import { InteractionType, InteractionResponseType, verifyKey } from 'discord-interactions';

async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const PUBLIC_KEY = process.env.PUBLIC_KEY;

export default async function handler(req, res) {
  // 有些環境會先送 HEAD；直接 200 讓 Portal 不報錯
  if (req.method === 'HEAD') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

  const sig = req.headers['x-signature-ed25519'];
  const ts  = req.headers['x-signature-timestamp'];
  const body = await readRawBody(req);

  // 有些版本的 discord-interactions 在某些 bundler 下需要 await
  const ok = await verifyKey(body, sig, ts, PUBLIC_KEY);
  if (!ok) { res.status(401).send('invalid request signature'); return; }

  const i = JSON.parse(body);

  if (i.type === InteractionType.PING) {
    // 也把哪個 app 來 ping 印到 log（你已證明一致）
    console.log('PING from application_id =', i.application_id);
    return res.status(200).json({ type: InteractionResponseType.PONG });
  }

  return res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: 'OK', flags: 64 }
  });
}
