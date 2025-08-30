// api/discord.js — 穩定版（含管理：踢人 / 移組）
//
// - /cteam：直接回最終訊息（type:4）
// - 按鈕：加入/離開 -> UPDATE_MESSAGE（type:7）
// - 查看所有名單：ephemeral；若是主揪或有 Manage Messages 權限，再顯示「管理：踢人 / 移組」
// - 踢人/移組：使用 Modal；提交後用 BOT_TOKEN 直接 PATCH 原訊息（不受 3 秒限制）
// - 狀態（multi/members/title）採 spoiler + Base64 隱藏，舊訊息 HTML 註解仍可讀
// - 仍保留 /leaveall（ephemeral 說明）

import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from "discord-interactions";

export const config = { runtime: "nodejs" };

/* ============== small utils ============== */
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

/* -------- 舊式 HTML 註解讀寫（相容用） -------- */
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

/* -------- 新版隱藏狀態：spoiler + Base64 -------- */
const b64e = (x) => Buffer.from(String(x), "utf8").toString("base64");
const b64d = (x) => Buffer.from(String(x), "base64").toString("utf8");

const RE_M   = /\|\|<m:([01])>\|\|/;
const RE_MEM = /\|\|<mem:([A-Za-z0-9+/=]+)>\|\|/;
const RE_TTL = /\|\|<ttl:([A-Za-z0-9+/=]+)>\|\|/;

const RE_M_ALL   = new RegExp(RE_M, "g");
const RE_MEM_ALL = new RegExp(RE_MEM, "g");
const RE_TTL_ALL = new RegExp(RE_TTL, "g");

function getMulti(content) {
  const m = content.match(RE_M);
  if (m) return m[1] === "1";
  return (between(content, "<!-- multi:", " -->") || "").trim() === "true";
}
function setMulti(content, multi) {
  let s = content.replace(RE_M_ALL, "");
  s = removeBlock(s, "<!-- multi:", " -->");
  return `${s}\n\n||<m:${multi ? "1" : "0"}>||`;
}
function getMembers(content, count) {
  try {
    const m = content.match(RE_MEM);
    if (m) {
      const obj = JSON.parse(b64d(m[1]));
      for (let i = 1; i <= count; i++) if (!obj[String(i)]) obj[String(i)] = [];
      return obj;
    }
  } catch {}
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
  let s = content.replace(RE_MEM_ALL, "");
  s = removeBlock(s, "<!-- members:", " -->");
  return `${s}\n||<mem:${b64e(JSON.stringify(obj))}>||`;
}
function getTitle(content) {
  try {
    const m = content.match(RE_TTL);
    if (m) return b64d(m[1]).trim();
  } catch {}
  return (between(content, "<!-- title:", " -->") || "").trim();
}
function setTitle(content, title) {
  let s = content.replace(RE_TTL_ALL, "");
  s = removeBlock(s, "<!-- title:", " -->");
  return title ? `${s}\n||<ttl:${b64e(title)}>||` : s;
}

/* -------- 按鈕列：最多 5 列（每列 ≤5） -------- */
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

/* -------- 取人名（可選） -------- */
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
  } catch { return null; }
}
async function buildSortedLabelList(guildId, ids) {
  const labels = await Promise.all(ids.map((id) => fetchMemberLabel(guildId, id)));
  const list = labels.map((l, i) => l || `<@${ids[i]}>`);
  const collator = new Intl.Collator("zh-Hant", { sensitivity: "base", numeric: true });
  return list.sort((a, b) => collator.compare(a, b));
}

/* -------- 權限判斷 -------- */
function hasManageMessages(i) {
  try {
    const permStr = i.member?.permissions || "0";
    const bits = BigInt(permStr);
    const MANAGE_MESSAGES = 1n << 13n; // 8192
    return (bits & MANAGE_MESSAGES) !== 0n;
  } catch { return false; }
}
function isManager(i, msgAuthorId) {
  const self = i.member?.user?.id;
  return self === msgAuthorId || hasManageMessages(i);
}

/* -------- BOT_TOKEN 操作訊息 -------- */
async function getMessage(channelId, messageId) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("missing BOT_TOKEN");
  const r = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
    { headers: { Authorization: `Bot ${token}` } }
  );
  if (!r.ok) throw new Error(`getMessage failed ${r.status}`);
  return r.json();
}
async function patchMessage(channelId, messageId, payload) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("missing BOT_TOKEN");
  const r = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  if (!r.ok) throw new Error(`patchMessage failed ${r.status}`);
  return r.json();
}

/* -------- 解析 mention/ID -------- */
function extractUserId(s) {
  const m = String(s).match(/\d{15,25}/);
  return m ? m[0] : null;
}

/* ============== main handler ============== */
export default async function handler(req, res) {
  if (req.method === "HEAD") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const sig = req.headers["x-signature-ed25519"];
  const ts  = req.headers["x-signature-timestamp"];
  const raw = await readRawBody(req);
  const ok  = verifyKey(raw, sig, ts, process.env.PUBLIC_KEY);
  if (!ok)  return res.status(401).send("invalid request signature");

  const i = JSON.parse(raw);

  // PING
  if (i.type === InteractionType.PING) {
    return res.status(200).json({ type: InteractionResponseType.PONG });
  }

  // Slash
  if (i.type === InteractionType.APPLICATION_COMMAND) {
    const name = i.data?.name;

    if (name === "cteam") {
      try {
        const capsRaw    = i.data.options?.find(o => o.name === "caps")?.value ?? "12,12,12";
        const allowMulti = i.data.options?.find(o => o.name === "multi")?.value ?? false;
        const title      = (i.data.options?.find(o => o.name === "title")?.value ?? "").trim();
        const caps = parseCapsInput(capsRaw);

        if (!caps.length || caps.length > 12) {
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `名額格式錯誤，或團數過多（最多 12 團）。`, flags: 64 }
          });
        }

        let content = buildContentFromCaps(caps);
        if (title) content = `${title}\n\n${content}`;
        content = setMulti(content, !!allowMulti);
        content = setMembers(
          content,
          Object.fromEntries(caps.map((_, idx) => [String(idx + 1), []]))
        );
        content = setTitle(content, title);

        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content,
            components: buildComponentsPacked(caps),
            allowed_mentions: { parse: [] },
          },
        });
      } catch (e) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `建立訊息時發生錯誤。`, flags: 64 }
        });
      }
    }

    if (name === "leaveall") {
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `請到開團訊息下方，對你所在的每團按「離開」。`, flags: 64 }
      });
    }

    return res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `未知指令：${name}`, flags: 64 }
    });
  }

  // 按鈕
  if (i.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = i.data?.custom_id;
    const msg = i.message;
    const userId = i.member?.user?.id || i.user?.id;

    if (customId === "view_all") {
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

      // 管理按鈕（只給主揪或有 Manage Messages 權限的人）
      const manager = isManager(i, msg.author?.id);
      const comps = manager
        ? [{
            type: 1,
            components: [
              {
                type: 2, style: 4,
                custom_id: `admin_kick_open:${msg.channel_id}:${msg.id}`,
                label: "管理：踢人"
              },
              {
                type: 2, style: 1,
                custom_id: `admin_move_open:${msg.channel_id}:${msg.id}`,
                label: "管理：移組"
              }
            ]
          }]
        : [];

      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: parts.join("\n\n"),
          components: comps,
          flags: 64,
          allowed_mentions: { parse: [] }
        },
      });
    }

    // 開啟管理 Modal（踢人）
    if (customId?.startsWith("admin_kick_open:")) {
      const [ , ch, mid ] = customId.split(":");
      return res.status(200).json({
        type: 9, // MODAL
        data: {
          custom_id: `modal_kick:${ch}:${mid}`,
          title: "踢人（從所有團移除）",
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4, custom_id: "user",
                  style: 1, label: "成員（@或ID）",
                  min_length: 1, max_length: 50, required: true
                }
              ]
            }
          ]
        }
      });
    }

    // 開啟管理 Modal（移組）
    if (customId?.startsWith("admin_move_open:")) {
      const [ , ch, mid ] = customId.split(":");
      return res.status(200).json({
        type: 9, // MODAL
        data: {
          custom_id: `modal_move:${ch}:${mid}`,
          title: "移組（1~N）",
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4, custom_id: "user",
                  style: 1, label: "成員（@或ID）",
                  min_length: 1, max_length: 50, required: true
                }
              ]
            },
            {
              type: 1,
              components: [
                {
                  type: 4, custom_id: "target",
                  style: 1, label: "目標團（數字）",
                  min_length: 1, max_length: 3, required: true
                }
              ]
            }
          ]
        }
      });
    }

    // 一般加入/離開
    const m = customId?.match(/^(join|leave)_(\d+)$/);
    if (!m) {
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `未知按鈕。`, flags: 64 }
      });
    }

    const action = m[1];
    const idx = parseInt(m[2], 10);
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
    const title2 = getTitle(msg.content);
    if (title2) content = `${title2}\n\n${content}`;
    content = setMulti(content, multi);
    content = setMembers(content, members);
    content = setTitle(content, title2);

    return res.status(200).json({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: {
        content,
        components: buildComponentsPacked(capsNow),
        allowed_mentions: { parse: [] },
      },
    });
  }

  // Modal Submit：踢人 / 移組
  if (i.type === InteractionType.MODAL_SUBMIT) {
    const cid = i.data?.custom_id || "";
    const [kind, ch, mid] = cid.split(":"); // modal_kick / modal_move
    const valMap = {};
    for (const row of i.data.components || []) {
      for (const c of row.components || []) {
        valMap[c.custom_id] = c.value;
      }
    }

    // 只有主揪 / 管理員可以執行：再查一次原訊息作者
    try {
      const msg = await getMessage(ch, mid);
      const manager = isManager(i, msg.author?.id);
      if (!manager) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "你沒有權限執行此操作。", flags: 64 }
        });
      }

      const contentOld = msg.content || "";
      const capsNow = parseCapsFromContent(contentOld);
      let members = getMembers(contentOld, capsNow.length);
      const title = getTitle(contentOld);
      const multi = getMulti(contentOld);

      // 解析 user id
      const uid = extractUserId(valMap.user);
      if (!uid) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "成員格式錯誤，請輸入 @或純 ID。", flags: 64 }
        });
      }

      if (kind === "modal_kick") {
        // 從所有團移除
        let removed = 0;
        for (let g = 1; g <= capsNow.length; g++) {
          const arr = members[String(g)] || [];
          const before = arr.length;
          members[String(g)] = arr.filter((x) => x !== uid);
          if (arr.length !== before) {
            capsNow[g - 1] += 1;
            removed++;
          }
        }
        if (!removed) {
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "該成員不在任何團。", flags: 64 }
          });
        }

        let content = buildContentFromCaps(capsNow);
        if (title) content = `${title}\n\n${content}`;
        content = setMulti(content, multi);
        content = setMembers(content, members);
        content = setTitle(content, title);

        await patchMessage(ch, mid, {
          content,
          components: buildComponentsPacked(capsNow),
          allowed_mentions: { parse: [] },
        });

        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `已踢除 <@${uid}>（從所有團移除）`, flags: 64 }
        });
      }

      if (kind === "modal_move") {
        const t = parseInt(String(valMap.target || "").trim(), 10);
        if (!Number.isInteger(t) || t < 1 || t > capsNow.length) {
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "目標團輸入錯誤。", flags: 64 }
          });
        }

        // 先找出目前在哪些團
        let had = false;
        for (let g = 1; g <= capsNow.length; g++) {
          const arr = members[String(g)] || [];
          const before = arr.length;
          members[String(g)] = arr.filter((x) => x !== uid);
          if (arr.length !== before) {
            capsNow[g - 1] += 1;
            had = true;
          }
        }
        // 加入目標團
        if (capsNow[t - 1] <= 0) {
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `目標團已滿。`, flags: 64 }
          });
        }
        (members[String(t)] ||= []).push(uid);
        capsNow[t - 1] -= 1;

        let content = buildContentFromCaps(capsNow);
        if (title) content = `${title}\n\n${content}`;
        content = setMulti(content, multi);
        content = setMembers(content, members);
        content = setTitle(content, title);

        await patchMessage(ch, mid, {
          content,
          components: buildComponentsPacked(capsNow),
          allowed_mentions: { parse: [] },
        });

        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `已將 <@${uid}> 移至第 ${t} 團${had ? "（並從其他團移除）" : ""}`, flags: 64 }
        });
      }

      // 未知 modal
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "未知操作。", flags: 64 }
      });
    } catch (e) {
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `操作失敗：${e.message || e}`, flags: 64 }
      });
    }
  }

  // 其他型別
  return res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `DEBUG fallback type=${i.type}`, flags: 64 }
  });
}
