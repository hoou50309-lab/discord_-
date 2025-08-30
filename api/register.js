// /api/register.js
// 註冊 /cteam 指令（支援 global 或多 Guild）
// 認證：在 Header 帶 x-admin-key，值需等於 process.env.ADMIN_KEY

const APP_ID = process.env.APP_ID || "";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// == 指令定義（完整 payload）==
const COMMANDS = [
  {
    name: "cteam",
    type: 1, // CHAT_INPUT
    description: "建立/更新分組名單訊息",
    options: [
      {
        type: 3, // STRING
        name: "caps",
        description: "每團名額，用逗號分隔（例如：5,3,2）",
        required: false,
      },
      {
        type: 5, // BOOLEAN
        name: "multi",
        description: "允許同時加入多團",
        required: false,
      },
      {
        type: 3, // STRING
        name: "title",
        description: "標題（可留空）",
        required: false,
      },
      {
        type: 3, // STRING
        name: "defaults",
        description:
          "預設名單（文字）：每行「<團號>: <@成員1> <@成員2>」，例：1: <@123> <@456>",
        required: false,
      },
      {
        type: 11, // ATTACHMENT
        name: "defaults_file",
        description:
          "上傳預設名單檔（txt/md/csv）。CSV 支援 group,member_id 欄位",
        required: false,
      },
    ],
    // default_member_permissions: null,
    // dm_permission: true,
    // nsfw: false,
  },
];

export default async function handler(req, res) {
  if (req.method !== "PUT") return res.status(405).send("Method Not Allowed");

  // 簡單管理金鑰
  const key = req.headers["x-admin-key"];
  if (!ADMIN_KEY || key !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: "bad admin key" });
  }
  if (!APP_ID || !BOT_TOKEN) {
    return res
      .status(500)
      .json({ ok: false, error: "APP_ID / BOT_TOKEN not set" });
  }

  const { scope = "", guilds = "", clear = "" } = req.query || {};
  const wantGlobal = String(scope).toLowerCase() === "global";
  const guildList = String(guilds || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!wantGlobal && guildList.length === 0) {
    return res.status(400).json({
      ok: false,
      error:
        'Provide ?scope=global or ?guilds=ID[,ID2] (optional &clear=true)',
    });
  }

  const base = `https://discord.com/api/v10/applications/${APP_ID}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bot ${BOT_TOKEN}`,
  };
  const payload = String(clear).toLowerCase() === "true" ? [] : COMMANDS;

  const targets = [];
  if (wantGlobal) targets.push({ url: `${base}/commands` });
  for (const gid of guildList) {
    targets.push({ url: `${base}/guilds/${gid}/commands` });
  }

  const results = [];
  for (const t of targets) {
    const r = await fetch(t.url, {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    results.push({ status: r.status, text });
  }
  return res.status(200).json({ ok: true, results });
}

export const config = { api: { bodyParser: false } };
