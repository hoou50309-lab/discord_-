// api/discord.js — minimal handshake with logging
import { InteractionType, InteractionResponseType, verifyKey } from 'discord-interactions';

async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const PUBLIC_KEY = process.env.PUBLIC_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const rawBody   = await readRawBody(req);

  const isValid = verifyKey(rawBody, signature, timestamp, PUBLIC_KEY);
  if (!isValid) {
    res.status(401).send('invalid request signature');
    return;
  }

  const i = JSON.parse(rawBody);

  // 這一行就是我要你加的 log（印出哪個 App 在 PING）
  if (i.type === InteractionType.PING) {
    console.log('PING from application_id =', i.application_id);
    return res.status(200).json({ type: InteractionResponseType.PONG });
  }

  // 其他互動先回一則 ephemeral 文字
  return res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: 'OK', flags: 64 }
  });
}
