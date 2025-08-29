// api/register.js — 一鍵註冊公會指令（受 x-admin-key 保護）
const COMMANDS = [
  {
    name: "cteam",
    description: "建立 N 團訊息（預設 12,12,12）",
    options: [
      { type: 3, name: "caps", description: "各團名額，如 12,12,12", required: false },
      { type: 5, name: "multi", description: "允許同一人加入多團", required: false },
      { type: 3, name: "title", description: "訊息標題", required: false },
      { type: 3, name: "defaults", description: "預設名單，例如：1: <@ID> <@ID>\\n2: <@ID>", required: false }
    ]
  },
  {
    name: "myteams",
    description: "查詢我在指定開團訊息的所屬團",
    options: [{ type: 3, name: "message_id", description: "目標訊息 ID", required: false }]
  },
  {
    name: "leaveall",
    description: "安全離團指引（避免跨訊息編輯）",
    options: [{ type: 3, name: "message_id", description: "目標訊息 ID", required: false }]
  }
];

export default async function handler(req, res) {
  if (req.method === 'HEAD') return res.status(200).end();
  if (req.method !== 'PUT') return res.status(405).send('Method Not Allowed');

  // 簡單管理授權
  const admin = req.headers['x-admin-key'];
  if (!admin || admin !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const appId   = process.env.APP_ID;
  const guildId = process.env.GUILD_ID;
  const token   = process.env.BOT_TOKEN;
  if (!appId || !guildId || !token) {
    return res.status(500).json({ error: 'missing env: APP_ID / GUILD_ID / BOT_TOKEN' });
  }

  const endpoint = `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`;
  const r = await fetch(endpoint, {
    method: 'PUT',
    headers: { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(COMMANDS),
  });

  const text = await r.text();
  res.status(r.status).send(text);
}
