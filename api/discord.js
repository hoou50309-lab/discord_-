// api/discord.js — Stable, fast join/leave, hidden STATE, admin kick/move
import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from "discord-interactions";

/* =============== utils =============== */
async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const HAN = ["零","一","二","三","四","五","六","七","八","九","十","十一","十二","十三","十四","十五","十六","十七","十八","十九","二十"];
const numToHan = (n) => HAN[n] ?? String(n);

// ---- Hidden STATE by masked link with non-empty invisible text ----
const INV = "\u2063\u200B\u3164"; // Invisible separator + ZWSP + Hangul filler (不會被 Discord 減掉)
function encodeState(state) {
  const b64 = Buffer.from(JSON.stringify(state)).toString("base64");
  // 使用 invalid domain 避免 preview；文字是 INV，不會顯示
  return `\n[${INV}](https://discord.invalid/#STATE:${b64})`;
}
function tryParseStateFromContent(content) {
  const m = content.match(/#STATE:([A-Za-z0-9+/=]+)/);
  if (!m) return null;
  try { return JSON.parse(Buffer.from(m[1], "base64").toString("utf8")); }
  catch { return null; }
}

/* =============== Discord REST =============== */
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const DC_HEADERS = BOT_TOKEN ? { "Authorization": `Bot ${BOT_TOKEN}`, "Content-Type":"application/json" } : null;

async function getMessage(channelId, messageId) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN required to GET message.");
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
    method: "GET",
    headers: { "Authorization": `Bot ${BOT_TOKEN}` }
  });
  if (!r.ok) throw new Error(`getMessage ${r.status}`);
  return r.json();
}

async function patchMessageViaBot(channelId, messageId, payload) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN required to PATCH message.");
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH",
    headers: DC_HEADERS,
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error(`patch message failed ${r.status} ${t}`);
  }
}

/* =============== renderers =============== */
function initMembers(count) {
  const obj = {};
  for (let i = 1; i <= count; i++) obj[String(i)] = [];
  return obj;
}
function parseCaps(raw) {
  const caps = String(raw ?? "12,12,12")
    .split(",")
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n) && n >= 0);
  return caps.length ? caps : [12,12,12];
}

function buildComponents(groupCount, withAdminBtn=true) {
  const rows = Array.from({ length: groupCount }, (_, i) => {
    const n = i + 1;
    return {
      type: 1,
      components: [
        { type: 2, style: 3, custom_id: `join_${n}`,  label: `加入第${numToHan(n)}團` },
        { type: 2, style: 2, custom_id: `leave_${n}`, label: `離開第${numToHan(n)}團` },
      ],
    };
  });
  if (withAdminBtn && rows.length < 5) {
    rows.push({
      type: 1,
      components: [
        { type: 2, style: 1, custom_id: "admin_manage", label: "管理名單（踢人 / 移組）" }
      ],
    });
  }
  return rows.slice(0, 5);
}

function renderVisibleContentFast(state) {
  const { title, caps, members } = state;

  const remain = caps.map((cap, i) => {
    const used = (members[String(i + 1)] || []).length;
    const r = cap - used;
    return r >= 0 ? r : 0;
  });

  const lines = [];
  if (title) lines.push(`${title}`);
  for (let i = 0; i < caps.length; i++) {
    lines.push(`第${numToHan(i + 1)}團（-${remain[i]}）`);
  }
  lines.push("");
  lines.push("目前名單：");
  for (let i = 0; i < caps.length; i++) {
    const arr = members[String(i + 1)] || [];
    if (arr.length === 0) {
      lines.push(`第${numToHan(i + 1)}團： （無）`);
    } else {
      // 用 <@id> 顯示，Discord 會以暱稱渲染，但不會 ping（因為我們不允許 mentions）
      lines.push(`第${numToHan(i + 1)}團： ${arr.map(uid => `<@${uid}>`).join(" ")}`);
    }
  }
  return lines.join("\n") + encodeState(state);
}

/* =============== core =============== */
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const sig = req.headers["x-signature-ed25519"];
  const ts  = req.headers["x-signature-timestamp"];
  if (!sig || !ts) return res.status(401).send("missing signature headers");

  const raw = await readRawBody(req);
  let ok = false;
  try { ok = verifyKey(raw, sig, ts, process.env.PUBLIC_KEY); } catch { ok = false; }
  if (!ok) return res.status(401).send("invalid request signature");

  const i = JSON.parse(raw);

  // PING
  if (i.type === InteractionType.PING) {
    return res.status(200).json({ type: InteractionResponseType.PONG });
  }

  // Slash commands
  if (i.type === InteractionType.APPLICATION_COMMAND) {
    if (i.data?.name === "cteam") {
      const caps = parseCaps(i.data.options?.find(o => o.name === "caps")?.value ?? "12,12,12");
      const multi = !!(i.data.options?.find(o => o.name === "multi")?.value ?? false);
      const title = String(i.data.options?.find(o => o.name === "title")?.value ?? "").trim();
      const defaultsStr = i.data.options?.find(o => o.name === "defaults")?.value ?? "";

      if (caps.length * 2 > 25) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `團數過多（${caps.length} 團），每團 2 顆按鈕，最多 12 團。`, flags: 64 }
        });
      }

      const state = { title, caps, multi, members: initMembers(caps.length) };

      // 預設名單： 1: <@ID> <@ID>\n2: <@ID>
      if (defaultsStr) {
        const lines = defaultsStr.split(/\r?\n/);
        for (const line of lines) {
          const m = line.match(/^\s*(\d+)\s*:\s*(.*)$/);
          if (!m) continue;
          const idx = parseInt(m[1], 10);
          const ids = (m[2] || "").match(/<@!?(\d+)>/g) || [];
          const onlyIds = ids.map(x => x.replace(/[<@!>]/g, ""));
          if (!state.members[String(idx)]) state.members[String(idx)] = [];
          for (const uid of onlyIds) {
            const cap = state.caps[idx - 1] ?? 0;
            const used = state.members[String(idx)].length;
            if (used < cap && !state.members[String(idx)].includes(uid)) state.members[String(idx)].push(uid);
          }
        }
      }

      const content = renderVisibleContentFast(state);
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content,
          components: buildComponents(caps.length, true),
          allowed_mentions: { parse: [] }, // 不 ping
        }
      });
    }

    if (i.data?.name === "leaveall") {
      const msgId = i.data.options?.find(o => o.name === "message_id")?.value ?? null;
      const note = msgId
        ? `請到目標訊息（ID: ${msgId}）按對應團的「離開」按鈕。`
        : `請至欲離開的開團訊息按「離開第Ｎ團」即可。`;
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `離團指引：\n${note}`, flags: 64 }
      });
    }

    return res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "未支援的指令。", flags: 64 }
    });
  }

  // Button / Component
  if (i.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = i.data?.custom_id || "";
    const message  = i.message;
    const userId   = i.member?.user?.id || i.user?.id;

    // 管理名單（主揪限定）→ 開 Modal
    if (customId === "admin_manage") {
      const ownerId = message?.interaction?.user?.id || "";
      if (!ownerId || userId !== ownerId) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "只有開團者可以使用管理功能。", flags: 64 }
        });
      }
      return res.status(200).json({
        type: InteractionResponseType.MODAL,
        data: {
          custom_id: `mgr:${message.id}:${ownerId}`,
          title: "管理名單（踢人 / 移組）",
          components: [
            { type: 1, components: [
              { type: 4, custom_id: "action", label: "動作：kick 或 move", style: 1, required: true, min_length: 4, max_length: 8 }
            ]},
            { type: 1, components: [
              { type: 4, custom_id: "user", label: "成員（@提及 或 ID）", style: 1, required: true }
            ]},
            { type: 1, components: [
              { type: 4, custom_id: "to", label: "目標團號（move 用）", style: 1, required: false }
            ]},
          ]
        }
      });
    }

    // 加入 / 離開
    const m = customId.match(/^(join|leave)_(\d+)$/);
    if (!m) {
      return res.status(200).json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
    }

    // 先 defer，避免卡住
    res.status(200).json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });

    (async () => {
      try {
        const state = tryParseStateFromContent(message.content);
        if (!state) return;

        const [_, action, numStr] = m;
        const idx = parseInt(numStr, 10);
        const key = String(idx);
        state.members[key] = state.members[key] || [];

        const myGroups = Object.entries(state.members)
          .filter(([, arr]) => arr.includes(userId))
          .map(([k]) => parseInt(k, 10));

        if (action === "join") {
          if (!state.multi && myGroups.length > 0) {
            await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: "你已在其它團（本訊息僅你可見）。", flags: 64, allowed_mentions: { parse: [] } })
            });
            return;
          }
          const cap = state.caps[idx - 1] ?? 0;
          const used = state.members[key].length;
          if (state.members[key].includes(userId)) {
            await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: "你已在該團（本訊息僅你可見）。", flags: 64, allowed_mentions: { parse: [] } })
            });
            return;
          }
          if (used >= cap) {
            await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: "該團已滿（本訊息僅你可見）。", flags: 64, allowed_mentions: { parse: [] } })
            });
            return;
          }
          state.members[key].push(userId);
        }

        if (action === "leave") {
          const pos = state.members[key].indexOf(userId);
          if (pos === -1) {
            await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: "你不在該團（本訊息僅你可見）。", flags: 64, allowed_mentions: { parse: [] } })
            });
            return;
          }
          state.members[key].splice(pos, 1);
        }

        const newContent = renderVisibleContentFast(state);
        await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}/messages/@original`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: newContent,
            components: buildComponents(state.caps.length, true),
            allowed_mentions: { parse: [] } // 不 ping
          })
        });
      } catch (e) { console.error("component error", e); }
    })();

    return;
  }

  // Modal submit（管理名單）
  if (i.type === InteractionType.MODAL_SUBMIT) {
    const cid = i.data?.custom_id || "";
    const mm = cid.match(/^mgr:(\d+):(\d+)$/);
    if (!mm) {
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "無效的管理操作。", flags: 64 }
      });
    }
    const [_, targetMsgId, ownerId] = mm;
    const actorId = i.member?.user?.id || i.user?.id || "";
    if (actorId !== ownerId) {
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "只有開團者可以使用此功能。", flags: 64 }
      });
    }

    const kv = new Map();
    for (const row of i.data.components || []) {
      for (const c of row.components || []) kv.set(c.custom_id, c.value ?? "");
    }
    const action = String(kv.get("action") || "").trim().toLowerCase();
    const userRaw = String(kv.get("user") || "").trim();
    const toRaw   = String(kv.get("to")   || "").trim();

    const userMatch = userRaw.match(/(\d{15,25})/);
    if (!userMatch) {
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "成員格式錯誤，請輸入 @提及 或 ID。", flags: 64 }
      });
    }
    const targetUserId = userMatch[1];

    let msg;
    try { msg = await getMessage(i.channel_id, targetMsgId); }
    catch (e) {
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `讀取訊息失敗：${String(e)}`, flags: 64 }
      });
    }

    const state = tryParseStateFromContent(msg.content);
    if (!state) {
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "找不到狀態（STATE），無法管理。", flags: 64 }
      });
    }

    const inGroups = Object.keys(state.members).filter(k => state.members[k].includes(targetUserId));

    if (action === "kick") {
      if (inGroups.length === 0) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "該成員不在任何團。", flags: 64 }
        });
      }
      for (const k of inGroups) {
        const pos = state.members[k].indexOf(targetUserId);
        if (pos >= 0) state.members[k].splice(pos, 1);
      }
      const newContent = renderVisibleContentFast(state);
      try {
        await patchMessageViaBot(i.channel_id, targetMsgId, {
          content: newContent,
          components: buildComponents(state.caps.length, true),
          allowed_mentions: { parse: [] }
        });
      } catch (e) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `更新訊息失敗：${String(e)}`, flags: 64 }
        });
      }
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "已踢除該成員。", flags: 64 }
      });
    }

    if (action === "move") {
      const to = parseInt(toRaw, 10);
      if (!Number.isInteger(to) || to < 1 || to > state.caps.length) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "目標團號不正確。", flags: 64 }
        });
      }
      for (const k of inGroups) {
        const pos = state.members[k].indexOf(targetUserId);
        if (pos >= 0) state.members[k].splice(pos, 1);
      }
      const cap = state.caps[to - 1] ?? 0;
      const used = state.members[String(to)].length ?? 0;
      if (used >= cap) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "目標團已滿。", flags: 64 }
        });
      }
      if (!state.members[String(to)]) state.members[String(to)] = [];
      if (!state.members[String(to)].includes(targetUserId)) state.members[String(to)].push(targetUserId);

      const newContent = renderVisibleContentFast(state);
      try {
        await patchMessageViaBot(i.channel_id, targetMsgId, {
          content: newContent,
          components: buildComponents(state.caps.length, true),
          allowed_mentions: { parse: [] }
        });
      } catch (e) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `更新訊息失敗：${String(e)}`, flags: 64 }
        });
      }
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `已移至第 ${numToHan(to)} 團。`, flags: 64 }
      });
    }

    return res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "請輸入 action：kick 或 move。", flags: 64 }
    });
  }

  // 其它型別
  return res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: "未處理的互動類型。", flags: 64 }
  });
}
