// api/discord.js — Stable: slash 直接回覆（type:4），避免「正在思考」卡住
import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from "discord-interactions";

/* ---------- utils ---------- */
async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const HAN = ["零","一","二","三","四","五","六","七","八","九","十","十一","十二","十三","十四","十五","十六","十七","十八","十九","二十"];
const numToHan = (n) => HAN[n] ?? String(n);

// 把狀態塞在 spoiler（黑條）中，視覺等同隱藏
const STATE_PREFIX = "STATE:";
function encodeState(state) {
  return `\n\n||${STATE_PREFIX}${JSON.stringify(state)}||`;
}
function tryParseStateFromContent(content) {
  const m = content.match(/\|\|STATE:(\{[\s\S]*?\})\|\|/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/* ---------- builders ---------- */
function buildComponents(groupCount) {
  // 每團兩顆：加入/離開；每團一列
  return Array.from({ length: groupCount }, (_, i) => {
    const n = i + 1;
    return {
      type: 1,
      components: [
        { type: 2, style: 3, custom_id: `join_${n}`,  label: `加入第${numToHan(n)}團` },
        { type: 2, style: 2, custom_id: `leave_${n}`, label: `離開第${numToHan(n)}團` },
      ],
    };
  });
}

function visibleContentFromState(state) {
  const { title, caps, members, multi } = state;
  const total = caps; // 原始名額
  const remain = caps.map((cap, i) => {
    const used = (members[String(i + 1)] || []).length;
    const r = cap - used;
    return r >= 0 ? r : 0;
  });

  const lines = [];
  if (title) lines.push(`${title}`);

  for (let i = 0; i < total.length; i++) {
    const line = `第${numToHan(i + 1)}團（-${remain[i]}）`;
    lines.push(line);
  }

  // 顯示目前成員（僅 mention、但不 @ 通知）
  lines.push(""); // 空行
  const head = "目前名單：";
  lines.push(head);
  for (let i = 0; i < total.length; i++) {
    const arr = members[String(i + 1)] || [];
    const mentions = arr.map(id => `<@${id}>`).join(" ");
    lines.push(`第${numToHan(i + 1)}團：${mentions || "（無）"}`);
  }

  // 底部塞 spoiler 狀態
  return lines.join("\n") + encodeState({ title, caps: total, members, multi });
}

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

function applyDefaults(state, defaultsStr) {
  if (!defaultsStr) return;
  // 格式： 1: <@ID> <@ID>\n2: <@ID>
  const lines = defaultsStr.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s*:\s*(.*)$/);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    const ids = (m[2] || "")
      .match(/<@!?(\d+)>/g) || [];
    const onlyIds = ids.map(x => x.replace(/[<@!>]/g, ""));
    if (!state.members[String(idx)]) state.members[String(idx)] = [];
    for (const uid of onlyIds) {
      if (state.members[String(idx)].includes(uid)) continue;
      // 僅在沒爆滿時塞入
      const cap = state.caps[idx - 1] ?? 0;
      const used = state.members[String(idx)].length;
      if (used < cap) state.members[String(idx)].push(uid);
    }
  }
}

/* ---------- core ---------- */
export default async function handler(req, res) {
  // 僅接受 POST（避免 Portal 檢查誤判）
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const sig = req.headers["x-signature-ed25519"];
  const ts  = req.headers["x-signature-timestamp"];
  if (!sig || !ts) return res.status(401).send("missing signature headers");

  const raw = await readRawBody(req);

  // 驗簽，不通過 → 401
  let ok = false;
  try { ok = verifyKey(raw, sig, ts, process.env.PUBLIC_KEY); } catch { ok = false; }
  if (!ok) return res.status(401).send("invalid request signature");

  const i = JSON.parse(raw);

  // PING → PONG
  if (i.type === InteractionType.PING) {
    return res.status(200).json({ type: InteractionResponseType.PONG });
  }

  // Slash
  if (i.type === InteractionType.APPLICATION_COMMAND) {
    if (i.data?.name === "cteam") {
      // 直接 type:4 回應 → 不會卡住
      const caps = parseCaps(
        i.data.options?.find(o => o.name === "caps")?.value ?? "12,12,12"
      );
      const multi = !!(i.data.options?.find(o => o.name === "multi")?.value ?? false);
      const title = String(i.data.options?.find(o => o.name === "title")?.value ?? "").trim();
      const defaultsStr = i.data.options?.find(o => o.name === "defaults")?.value ?? "";

      if (caps.length * 2 > 25) {
        // 安全提示（按鈕總數受限）
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `團數過多（${caps.length} 團），每團 2 顆按鈕，最多 12 團。`, flags: 64 }
        });
      }

      const state = {
        title,
        caps,
        multi,
        members: initMembers(caps.length),
      };
      applyDefaults(state, defaultsStr);

      const content = visibleContentFromState(state);
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, // 直接回覆
        data: {
          content,
          components: buildComponents(caps.length),
          allowed_mentions: { parse: [] }
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

    // 未支援的指令
    return res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "未支援的指令。", flags: 64 }
    });
  }

  // 按鈕互動
  if (i.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = i.data?.custom_id || "";
    const message  = i.message;
    const userId   = i.member?.user?.id || i.user?.id;

    // 先回「defer update」，再於背景 PATCH 原訊息
    res.status(200).json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });

    (async () => {
      try {
        const state = tryParseStateFromContent(message.content);
        if (!state) return;

        const m = customId.match(/^(join|leave)_(\d+)$/);
        if (!m) return;
        const action = m[1];
        const idx = parseInt(m[2], 10); // 1-based

        const caps = state.caps;
        const groupKey = String(idx);
        state.members[groupKey] = state.members[groupKey] || [];

        const myGroups = Object.entries(state.members)
          .filter(([, arr]) => Array.isArray(arr) && arr.includes(userId))
          .map(([k]) => parseInt(k, 10));

        // join
        if (action === "join") {
          if (!state.multi && myGroups.length > 0) {
            await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: "你已在其它團（本訊息僅你可見）。", flags: 64, allowed_mentions: { parse: [] } })
            });
            return;
          }
          const cap = caps[idx - 1] ?? 0;
          const used = state.members[groupKey].length;
          const has = state.members[groupKey].includes(userId);

          if (has) {
            await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: "你已在該團（本訊息僅你可見）。", flags: 64, allowed_mentions: { parse: [] } })
            });
            return;
          }
          if (used >= cap) {
            await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: "該團已滿（本訊息僅你可見）。", flags: 64, allowed_mentions: { parse: [] } })
            });
            return;
          }
          state.members[groupKey].push(userId);
        }

        // leave
        if (action === "leave") {
          const arr = state.members[groupKey];
          const pos = arr.indexOf(userId);
          if (pos === -1) {
            await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: "你不在該團（本訊息僅你可見）。", flags: 64, allowed_mentions: { parse: [] } })
            });
            return;
          }
          arr.splice(pos, 1);
        }

        // 更新訊息
        const newContent = visibleContentFromState(state);
        await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}/messages/@original`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: newContent,
            components: buildComponents(caps.length),
            allowed_mentions: { parse: [] }
          })
        });
      } catch (e) {
        console.error("component error", e);
      }
    })();

    return;
  }

  // 其它型別
  return res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: "未處理的互動類型。", flags: 64 }
  });
}
