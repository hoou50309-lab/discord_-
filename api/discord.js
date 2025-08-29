// api/discord.js — Slash 全改用方案 A（defer → PATCH @original）
// - /cteam   : 公開 → defer → PATCH @original 放主訊息＋按鈕
// - /myteams : ephemeral → defer(flags:64) → PATCH @original 回查詢結果
// - /leaveall: ephemeral → defer(flags:64) → PATCH @original 回操作指引
// - 按鈕：join/leave → type:6(DEFERRED_UPDATE_MESSAGE) → PATCH @original
//        view_all → 直接回 ephemeral 總覽
import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from "discord-interactions";

export const config = { runtime: "nodejs18.x" };

/* -------------------- utils -------------------- */
async function readRawBody(req) {
  const buf = [];
  for await (const c of req) buf.push(c);
  return Buffer.concat(buf).toString("utf8");
}
const HAN = [
  "零","一","二","三","四","五","六","七","八","九","十",
  "十一","十二","十三","十四","十五","十六","十七","十八","十九","二十"
];
const han = (n) => HAN[n] ?? String(n);

const buildContentFromCaps = (caps) =>
  caps.map((n, i) => `第${han(i + 1)}團（-${n}）`).join("\n\n");

function buildComponents(caps) {
  const rows = caps.map((_, i) => ({
    type: 1,
    components: [
      { type: 2, style: 3, custom_id: `join_${i + 1}`,  label: `加入第${han(i + 1)}團` },
      { type: 2, style: 2, custom_id: `leave_${i + 1}`, label: `離開第${han(i + 1)}團` },
    ],
  }));
  if (!rows.length) rows.push({ type: 1, components: [] });
  rows[rows.length - 1].components.push({
    type: 2, style: 1, custom_id: "view_all", label: "查看所有名單",
  });
  return rows;
}

// 解析 caps 輸入
const parseCapsInput = (v) =>
  String(v)
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 0);

// 從內容解析目前各團剩餘名額
function parseCapsFromContent(content) {
  return content
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const a = line.lastIndexOf("（-");
      const b = line.lastIndexOf("）");
      if (a !== -1 && b !== -1 && b > a + 2) {
        const n = parseInt(line.slice(a + 2, b), 10);
        if (Number.isInteger(n)) return n;
      }
      return null;
    })
    .filter((n) => n !== null);
}

/* ---- 將狀態存到 content 註解區（不碰元件，便於 stateless） ---- */
function getBetween(s, start, stop) {
  const a = s.indexOf(start);
  if (a === -1) return null;
  const b = s.indexOf(stop, a + start.length);
  if (b === -1) return null;
  return s.slice(a + start.length, b);
}
function removeBlock(s, start, stop) {
  const a = s.indexOf(start);
  if (a === -1) return s;
  const b = s.indexOf(stop, a + start.length);
  if (b === -1) return s.slice(0, a).trim();
  return (s.slice(0, a) + s.slice(b + stop.length)).trim();
}

function getMulti(content) {
  const v = (getBetween(content, "<!-- multi:", " -->") || "").trim();
  return v === "true";
}
function setMulti(content, multi) {
  const w = removeBlock(content, "<!-- multi:", " -->");
  return `${w}\n\n<!-- multi:${multi ? "true" : "false"} -->`;
}
function getMembers(content, count) {
  try {
    const json = getBetween(content, "<!-- members:", " -->");
    if (!json)
      return Object.fromEntries(
        Array.from({ length: count }, (_, i) => [String(i + 1), []])
      );
    const obj = JSON.parse(json);
    for (let i = 1; i <= count; i++) if (!obj[String(i)]) obj[String(i)] = [];
    return obj;
  } catch {
    return Object.fromEntries(
      Array.from({ length: count }, (_, i) => [String(i + 1), []])
    );
  }
}
function setMembers(content, obj) {
  const w = removeBlock(content, "<!-- members:", " -->");
  return `${w}\n<!-- members: ${JSON.stringify(obj)} -->`;
}
function getTitle(content) {
  return (getBetween(content, "<!-- title:", " -->") || "").trim();
}
function setTitle(content, title) {
  const w = removeBlock(content, "<!-- title:", " -->");
  return title ? `${w}\n<!-- title: ${title} -->` : w;
}

/* ---- 取暱稱／名稱用（需 BOT_TOKEN） ---- */
async function fetchMemberLabel(guildId, userId) {
  const token = process.env.BOT_TOKEN;
  if (!token || !guildId) return null;
  try {
    const r = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
      { headers: { Authorization: `Bot ${token}` } }
    );
    if (!r.ok) return null;
    const m = await r.json();
    const base = m?.user?.global_name || m?.user?.username || `User ${userId}`;
    const nick = (m?.nick || "").trim();
    return nick ? `${base} (${nick})` : base;
  } catch {
    return null;
  }
}
async function buildSortedLabelList(guildId, ids) {
  const labels = await Promise.all(ids.map((id) => fetchMemberLabel(guildId, id)));
  const list = labels.map((l, i) => l || `<@${ids[i]}>`);
  const collator = new Intl.Collator("zh-Hant", { sensitivity: "base", numeric: true });
  return list.sort((a, b) => collator.compare(a, b));
}

/* ---- Webhook helpers ---- */
async function patchOriginal(appId, token, body) {
  await fetch(
    `https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
}
async function followup(appId, token, body) {
  await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* -------------------- handler -------------------- */
export default async function handler(req, res) {
  if (req.method === "HEAD") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const raw = await readRawBody(req);

  const valid = verifyKey(raw, signature, timestamp, process.env.PUBLIC_KEY);
  if (!valid) return res.status(401).send("invalid request signature");

  const i = JSON.parse(raw);

  // PING
  if (i.type === InteractionType.PING)
    return res.status(200).json({ type: InteractionResponseType.PONG });

  /* ---------- Slash commands (方案A) ---------- */
  if (i.type === InteractionType.APPLICATION_COMMAND) {
    const name = i.data?.name;

    // /cteam → 公開：defer → PATCH @original
    if (name === "cteam") {
      res
        .status(200)
        .json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

      try {
        const capsRaw =
          i.data.options?.find((o) => o.name === "caps")?.value ?? "12,12,12";
        const allowMulti =
          i.data.options?.find((o) => o.name === "multi")?.value ?? false;
        const title =
          (i.data.options?.find((o) => o.name === "title")?.value ?? "").trim();

        const caps = parseCapsInput(capsRaw);
        if (!caps.length || caps.length * 2 > 25) {
          await followup(i.application_id, i.token, {
            content: "名額格式錯誤或團數過多（最多 12 團）。",
            flags: 64,
          });
          return;
        }

        let content = buildContentFromCaps(caps);
        if (title) content = `${title}\n\n${content}`;
        content = setMulti(content, !!allowMulti);
        content = setMembers(
          content,
          Object.fromEntries(caps.map((_, idx) => [String(idx + 1), []]))
        );
        content = setTitle(content, title);

        await patchOriginal(i.application_id, i.token, {
          content,
          components: buildComponents(caps),
          allowed_mentions: { parse: [] },
        });
      } catch (e) {
        console.error("cteam error", e);
        await followup(i.application_id, i.token, {
          content: "建立訊息時發生錯誤。",
          flags: 64,
        });
      }
      return;
    }

    // /myteams → ephemeral：defer(flags:64) → PATCH @original
    if (name === "myteams") {
      res.status(200).json({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: 64 },
      });

      try {
        const messageId =
          (i.data.options?.find((o) => o.name === "message_id")?.value ?? "").trim();
        if (!messageId) {
          await patchOriginal(i.application_id, i.token, {
            content: "請提供 message_id（訊息『更多』→ 複製連結）。",
            flags: 64,
          });
          return;
        }
        if (!process.env.BOT_TOKEN) {
          await patchOriginal(i.application_id, i.token, {
            content: "未設定 BOT_TOKEN，無法讀取訊息。",
            flags: 64,
          });
          return;
        }
        // 以當前頻道讀該訊息
        const r = await fetch(
          `https://discord.com/api/v10/channels/${i.channel_id}/messages/${messageId}`,
          { headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` } }
        );
        if (!r.ok) {
          await patchOriginal(i.application_id, i.token, {
            content: "找不到該訊息或權限不足。",
            flags: 64,
          });
          return;
        }
        const msg = await r.json();
        const capsNow = parseCapsFromContent(msg.content);
        const members = getMembers(msg.content, capsNow.length);
        const uid = i.member?.user?.id || i.user?.id;
        const mine = Object.entries(members)
          .filter(([, arr]) => arr.includes(uid))
          .map(([k]) => parseInt(k, 10));
        const reply = mine.length
          ? `你目前在第 ${mine.join(", ")} 團。`
          : "你目前未加入任何一團。";
        await patchOriginal(i.application_id, i.token, { content: reply, flags: 64 });
      } catch (e) {
        console.error("myteams error", e);
        await patchOriginal(i.application_id, i.token, {
          content: "查詢時發生錯誤。",
          flags: 64,
        });
      }
      return;
    }

    // /leaveall → ephemeral：defer(flags:64) → PATCH @original
    if (name === "leaveall") {
      res.status(200).json({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: 64 },
      });
      try {
        await patchOriginal(i.application_id, i.token, {
          content:
            "請到開團訊息下方，對你所在的每團按下「離開」。這樣最安全，也能避免跨訊息編輯衝突。",
          flags: 64,
        });
      } catch (e) {
        console.error("leaveall error", e);
        await patchOriginal(i.application_id, i.token, {
          content: "處理時發生錯誤。",
          flags: 64,
        });
      }
      return;
    }
  }

  /* ---------- 按鈕互動 ---------- */
  if (i.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = i.data?.custom_id;
    const message = i.message;
    const userId = i.member?.user?.id || i.user?.id;

    // 查看所有名單 → 直接回 ephemeral
    if (customId === "view_all") {
      const capsNow = parseCapsFromContent(message.content);
      const members = getMembers(message.content, capsNow.length);
      const guildId = i.guild_id;

      const parts = await Promise.all(
        capsNow.map(async (_, idx) => {
          const ids = members[String(idx + 1)] || [];
          const header = `第${han(idx + 1)}團名單（${ids.length} 人）`;
          if (!ids.length || !process.env.BOT_TOKEN || !guildId) {
            const list = ids.length ? ids.map((id) => `<@${id}>`).join("、") : "（尚無成員）";
            return `${header}\n${list}`;
          }
          const list = (await buildSortedLabelList(guildId, ids)).join("、") || "（尚無成員）";
          return `${header}\n${list}`;
        })
      );

      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: parts.join("\n\n"), flags: 64, allowed_mentions: { parse: [] } },
      });
    }

    // 其他按鈕：先 defer update，再 PATCH 原訊息
    res
      .status(200)
      .json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });

    (async () => {
      try {
        const capsNow = parseCapsFromContent(message.content);
        let multi = getMulti(message.content);
        let members = getMembers(message.content, capsNow.length);
        const title = getTitle(message.content);

        const m = customId.match(/^(join|leave)_(\d+)$/);
        if (!m) return;
        const action = m[1];
        const idx = parseInt(m[2], 10);

        const ids = members[String(idx)] || (members[String(idx)] = []);
        const inGroup = ids.includes(userId);

        const ep = async (text) =>
          followup(i.application_id, i.token, {
            content: text,
            flags: 64,
            allowed_mentions: { parse: [] },
          });

        if (action === "join") {
          if (!multi) {
            const has = Object.values(members).some((arr) => arr.includes(userId));
            if (has) return ep("你已在其他團中。");
          }
          if (capsNow[idx - 1] <= 0) return ep("該團已滿。");
          if (!inGroup) {
            ids.push(userId);
            capsNow[idx - 1] -= 1;
          } else {
            return ep("你已在該團。");
          }
        } else if (action === "leave") {
          if (!inGroup) return ep("你不在該團。");
          members[String(idx)] = ids.filter((x) => x !== userId);
          capsNow[idx - 1] += 1;
        }

        let content = buildContentFromCaps(capsNow);
        if (title) content = `${title}\n\n${content}`;
        content = setMulti(content, multi);
        content = setMembers(content, members);
        content = setTitle(content, title);

        await patchOriginal(i.application_id, i.token, {
          content,
          components: buildComponents(capsNow),
          allowed_mentions: { parse: [] },
        });
      } catch (e) {
        console.error("component error", e);
      }
    })();

    return;
  }

  // fallback
  return res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: "未處理的互動類型。", flags: 64 },
  });
}
