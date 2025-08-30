// api/register.js
// 一鍵註冊 / 更新公會指令（Bulk Overwrite）
// - PUT: 寫入（覆蓋） -> 只留下 cteam / leaveall
// - GET: 顯示目前已註冊的公會指令（簡易列表）
// - HEAD: 健康檢查
//
// 需要環境變數：APP_ID, GUILD_ID, BOT_TOKEN, ADMIN_KEY
// 安全：以 x-admin-key 做簡單保護（建議搭配 Vercel 的環境變數）
//
// 注意：這是「公會（Guild）」指令，變更生效幾乎即時（數秒）。
// 若改成 Global 指令，請改用另一個 API 路徑（/applications/{appId}/commands），
/* 但全球指令散播可能要幾十分鐘。 */

const COMMANDS = [
  {
    name: "cteam",
    description: "建立 N 團訊息（預設 12,12,12）",
    options: [
      { type: 3, name: "caps", description: "各團名額，如 12,12,12", required: false },
      { type: 5, name: "multi", description: "允許同一人加入多團", required: false },
      { type: 3, name: "title", description: "訊息標題", required: false },
      {
        type: 3,
        name: "defaults",
        description: "預設名單，例如：1: <@ID> <@ID>\\n2: <@ID>",
        required: false
      }
    ]
  },
  {
    name: "leaveall",
    description: "安全離團指引（避免跨訊息編輯）",
    options: [
      { type: 3, name: "message_id", description: "目標訊息 ID（可選）", required: false }
    ]
  }
];

async function fetchDiscord(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, ok: r.ok, data: json };
}

export default async function handler(req, res) {
  if (req.method === 'HEAD') {
    return res.status(200).end();
  }

  const admin = req.headers['x-admin-key'];
  if (!admin || admin !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const appId   = process.env.APP_ID;
  const guildId = process.env.GUILD_ID;
  const token   = process.env.BOT_TOKEN;

  if (!appId || !guildId || !token) {
    return res.status(500).json({
      error: 'missing env', need: ['APP_ID','GUILD_ID','BOT_TOKEN']
    });
  }

  const base = `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}`;

  // 顯示目前公會指令（簡易列表）
  if (req.method === 'GET') {
    const list = await fetchDiscord(`${base}/commands`, {
      headers: { Authorization: `Bot ${token}` }
    });
    if (!list.ok) {
      return res.status(list.status).json({ error: 'fetch commands failed', data: list.data });
    }
    // 回傳精簡清單
    const simple = Array.isArray(list.data)
      ? list.data.map(c => ({ id: c.id, name: c.name, description: c.description }))
      : list.data;
    return res.status(200).json({ ok: true, guild: guildId, commands: simple });
  }

  // Bulk Overwrite（覆蓋）
  if (req.method === 'PUT') {
    const write = await fetchDiscord(`${base}/commands`, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(COMMANDS)
    });

    if (!write.ok) {
      return res.status(write.status).json({
        ok: false,
        error: 'bulk overwrite failed',
        data: write.data
      });
    }
    // Discord 會回傳寫入後的指令陣列
    const simple = Array.isArray(write.data)
      ? write.data.map(c => ({ id: c.id, name: c.name, description: c.description }))
      : write.data;

    return res.status(200).json({
      ok: true,
      message: 'guild commands updated (cteam / leaveall). Old ones (e.g. myteams) removed.',
      guild: guildId,
      commands: simple
    });
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
