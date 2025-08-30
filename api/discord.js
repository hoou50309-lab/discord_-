// api/discord.js — 穩定版
// - /cteam：直接回最終內容（type:4），避免 thinking + PATCH
// - 按鈕 join/leave：即時 UPDATE_MESSAGE（type:7），不走 webhook → 不 timeout、不重發訊息
// - /myteams、/leaveall：直接回 ephemeral（type:4 + flags:64）
// - view_all：回一則 ephemeral 名單
// - 仍使用簡單的「文字內註解」保存狀態（multi/members/title），但不再附加版本字樣

import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from "discord-interactions";

export const config = { runtime: "nodejs" };

// 版本戳只用在 Logs（不插到訊息內容）
const VERSION =
  "dbg-" +
  new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12) +
  "-" +
  (process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "local");

/* ================= utils ================= */
async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const HAN = [
  "零","一","二","三","四","五","六","七","八","九","十",
  "十一","十二","十三","十四","十五","十六","十七","十八","十九","二十"
];
const han = (n) => HAN[n] ?? String(n);

const parseCapsInput = (v) =>
  String(v)
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 0);

const buildContentFromCaps = (caps) =>
  caps.map((n, i) => `第${han(i + 1)}團（-${n}）`).join("\n\n");

// 從內容還原各團剩餘名額
function parseCapsFromContent(content) {
  return content
    .split("\n").map((s) => s.trim()).filter(Boolean)
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

/* -------- state 存在訊息文字的註解 -------- */
function between(s, start, stop) {
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
  return (between(content, "<!-- multi:", " -->") || "").trim() === "true";
}
function setMulti(content, multi) {
  return `${removeBlock(content, "<!-- multi:", " -->")}\n\n<!-- multi:${multi ? "true" : "false"} -->`;
}
function getMembers(content, count) {
  try {
    const json = between(content, "<!-- members:", " -->");
    if (!json)
      return Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i + 1), []]));
    const obj = JSON.parse(json);
    for (let i = 1; i <= count; i++) if (!obj[String(i)]) obj[String(i)] = [];
    return obj;
  } catch {
    return Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i + 1), []]));
  }
}
function setMembers(content, obj) {
  return `${removeBlock(content, "<!-- members:", " -->")}\n<!-- members: ${JSON.stringify(obj)} -->`;
}
function getTitle(content) {
  return (between(content, "<!-- title:", " -->") || "").trim();
}
function setTitle(content, title) {
  const w = removeBlock(content, "<!-- title:", " -->");
  // 不再附加 VERSION；只純存 title
  return title ? `${w}\n<!-- title: ${title} -->` : w;
}

/* -------- 5 列封頂的按鈕排版（2*N + 1 ≤ 25） -------- */
function buildComponentsPacked(caps) {
  const buttons = [];
  caps.forEach((_, i) => {
    buttons.push({ type: 2, style: 3, custom_id: `join_${i + 1}`,  label: `加入第${han(i + 1)}團` });
    buttons.push({ type: 2, style: 2, custom_id: `leave_${i + 1}`, label: `離開第${han(i + 1)}團` });
  });
  buttons.push({ type: 2, style: 1, custom_id: "view_all", label: "查看所有名單" });

  const rows = [];
  for (let i = 0; i < buttons.length && rows.length < 5; i += 5) {
    rows.push({ type: 1, components: buttons.slice(i, i + 5) });
  }
  return rows;
}

/* -------- labels（optional BOT_TOKEN） -------- */
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

/* ================= handler ================= */
export default async function handler(req, res) {
  console.log("[ENTER]", { url: req.url, method: req.method, VERSION });

  if (req.method === "HEAD") { console.log("HEAD pong"); return res.status(200).end(); }
  if (req.method !== "POST") { console.log("405"); return res.status(405).send("Method Not Allowed"); }

  const sig = req.headers["x-signature-ed25519"];
  const ts  = req.headers["x-signature-timestamp"];
  const raw = await readRawBody(req);
  console.log("rawBody.len", raw?.length);

  const ok = verifyKey(raw, sig, ts, process.env.PUBLIC_KEY);
  if (!ok) { console.error("verifyKey failed"); return res.status(401).send("invalid request signature"); }

  const i = JSON.parse(raw);
  console.log("interaction", { type: i.type, name: i.data?.name, guild: i.guild_id, channel: i.channel_id });

  // PING
  if (i.type === InteractionType.PING) {
    console.log("PING -> PONG");
    return res.status(200).json({ type: InteractionResponseType.PONG });
  }

  // Slash commands
  if (i.type === InteractionType.APPLICATION_COMMAND) {
    const name = i.data?.name;
    console.log("slash name:", name);

    // /cteam：直接回最終內容（type:4）
    if (name === "cteam") {
      console.log("hit /cteam immediate", { VERSION });

      try {
        const capsRaw    = i.data.options?.find(o => o.name === "caps")?.value ?? "12,12,12";
        const allowMulti = i.data.options?.find(o => o.name === "multi")?.value ?? false;
        const title      = (i.data.options?.find(o => o.name === "title")?.value ?? "").trim();

        const caps = parseCapsInput(capsRaw);
        console.log("cteam parsed caps", caps);

        // 上限：最多 12 團（2*N + 1 ≤ 25 顆按鈕）
        if (!caps.length || caps.length > 12) {
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `名額格式錯誤，或團數過多（最多 12 團）。`, flags: 64 }
          });
        }

        // 文字
        let content = buildContentFromCaps(caps);
        if (title) content = `${title}\n\n${content}`;
        content = setMulti(content, !!allowMulti);
        content = setMembers(
          content,
          Object.fromEntries(caps.map((_, idx) => [String(idx + 1), []]))
        );
        content = setTitle(content, title); // 不附加 VERSION

        const body = {
          content,
          components: buildComponentsPacked(caps),
          allowed_mentions: { parse: [] },
        };

        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: body,
        });
      } catch (e) {
        console.error("cteam error", e);
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `建立訊息時發生錯誤。`, flags: 64 }
        });
      }
    }

    // /myteams：直接回 ephemeral
    if (name === "myteams") {
      console.log("hit /myteams", { VERSION });

      try {
        const messageId = (i.data.options?.find(o=>o.name==="message_id")?.value ?? "").trim();
        if (!messageId) {
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `請提供 message_id（訊息「更多」→ 複製連結）。`, flags: 64 }
          });
        }
        if (!process.env.BOT_TOKEN) {
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `未設定 BOT_TOKEN，無法讀取訊息。`, flags: 64 }
          });
        }

        const r = await fetch(
          `https://discord.com/api/v10/channels/${i.channel_id}/messages/${messageId}`,
          { headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` } }
        );
        if (!r.ok) {
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `找不到該訊息或權限不足。`, flags: 64 }
          });
        }
        const msg = await r.json();
        const capsNow = parseCapsFromContent(msg.content);
        const members = getMembers(msg.content, capsNow.length);
        const uid = i.member?.user?.id || i.user?.id;

        const mine = Object.entries(members)
          .filter(([, arr]) => arr.includes(uid))
          .map(([k]) => parseInt(k, 10));

        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `${mine.length ? `你目前在第 ${mine.join(", ")} 團。` : "你目前未加入任何一團。"}`, flags: 64 }
        });
      } catch (e) {
        console.error("myteams error", e);
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `查詢時發生錯誤。`, flags: 64 }
        });
      }
    }

    // /leaveall：直接回 ephemeral
    if (name === "leaveall") {
      console.log("hit /leaveall", { VERSION });
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `請到開團訊息下方，對你所在的每團按「離開」。`, flags: 64 }
      });
    }

    // 未知指令
    console.log("unknown slash name", name);
    return res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `未知指令：${name}`, flags: 64 }
    });
  }

  // 按鈕互動
  if (i.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = i.data?.custom_id;
    console.log("component", { customId, VERSION });

    const msg = i.message;
    const userId = i.member?.user?.id || i.user?.id;

    // 查看所有名單：回一則 ephemeral，不修改原訊息
    if (customId === "view_all") {
      console.log("hit view_all");
      const capsNow = parseCapsFromContent(msg.content);
      const members = getMembers(msg.content, capsNow.length);
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

    // 其餘 join/leave：直接 UPDATE_MESSAGE（type:7）
    const m = customId.match(/^(join|leave)_(\d+)$/);
    if (!m) {
      console.log("unknown component id", customId);
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `未知按鈕。`, flags: 64 }
      });
    }

    const action = m[1];
    const idx = parseInt(m[2], 10); // 1-based

    const capsNow = parseCapsFromContent(msg.content);
    let multi = getMulti(msg.content);
    let members = getMembers(msg.content, capsNow.length);
    const title = getTitle(msg.content);

    const ids = members[String(idx)] || (members[String(idx)] = []);
    const inGroup = ids.includes(userId);

    if (action === "join") {
      if (!multi) {
        const has = Object.values(members).some((arr) => arr.includes(userId));
        if (has) {
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `你已在其他團中。`, flags: 64 }
          });
        }
      }
      if (capsNow[idx - 1] <= 0) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `該團已滿。`, flags: 64 }
        });
      }
      if (!inGroup) {
        ids.push(userId);
        capsNow[idx - 1] -= 1;
      } else {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `你已在該團。`, flags: 64 }
        });
      }
    } else {
      if (!inGroup) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `你不在該團。`, flags: 64 }
        });
      }
      members[String(idx)] = ids.filter((x) => x !== userId);
      capsNow[idx - 1] += 1;
    }

    let content = buildContentFromCaps(capsNow);
    if (title) content = `${title}\n\n${content}`;
    content = setMulti(content, multi);
    content = setMembers(content, members);
    content = setTitle(content, title);

    return res.status(200).json({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        content,
        components: buildComponentsPacked(capsNow),
        allowed_mentions: { parse: [] },
      },
    });
  }

  // 其他型別
  console.log("fallback type", i.type);
  return res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `DEBUG fallback type=${i.type}`, flags: 64 }
  });
}
