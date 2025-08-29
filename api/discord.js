// api/discord.js — 方案A + 全面偵錯版
// - 在每個入口/分支 console.log 詳細資訊
// - PATCH 失敗印出 status / response text
// - fallback 回傳 "DEBUG fallback ..."（不再是 OK）
// - 按鈕打包成最多 5 列（支援 12 團）

import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from "discord-interactions";

export const config = { runtime: "nodejs18.x" };

// 版本戳，方便在訊息與日誌中辨識
const VERSION =
  "dbg-" +
  new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12) + "-" +
  (process.env.VERCEL_GIT_COMMIT_SHA?.slice(0,7) || "local");

// ===== utils =====
async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
const HAN = ["零","一","二","三","四","五","六","七","八","九","十","十一","十二","十三","十四","十五","十六","十七","十八","十九","二十"];
const han = (n) => HAN[n] ?? String(n);

const parseCapsInput = (v) =>
  String(v).split(",")
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n) && n >= 0);

const buildContentFromCaps = (caps) =>
  caps.map((n, i) => `第${han(i + 1)}團（-${n}）`).join("\n\n");

function parseCapsFromContent(content) {
  return content.split("\n").map(s => s.trim()).filter(Boolean)
    .map(line => {
      const a = line.lastIndexOf("（-"); const b = line.lastIndexOf("）");
      if (a !== -1 && b !== -1 && b > a+2) {
        const n = parseInt(line.slice(a+2, b), 10);
        if (Number.isInteger(n)) return n;
      }
      return null;
    }).filter(n => n !== null);
}

// ---- state in content comments ----
function between(s, start, stop) {
  const a = s.indexOf(start); if (a === -1) return null;
  const b = s.indexOf(stop, a + start.length); if (b === -1) return null;
  return s.slice(a + start.length, b);
}
function removeBlock(s, start, stop) {
  const a = s.indexOf(start); if (a === -1) return s;
  const b = s.indexOf(stop, a + start.length); if (b === -1) return s.slice(0, a).trim();
  return (s.slice(0, a) + s.slice(b + stop.length)).trim();
}
const getMulti = (c) => (between(c, "<!-- multi:", " -->") || "").trim() === "true";
const setMulti = (c, m) => `${removeBlock(c, "<!-- multi:", " -->")}\n\n<!-- multi:${m ? "true" : "false"} -->`;
function getMembers(content, count) {
  try {
    const json = between(content, "<!-- members:", " -->");
    if (!json) return Object.fromEntries(Array.from({length:count}, (_,i)=>[String(i+1), []]));
    const obj = JSON.parse(json);
    for (let i=1;i<=count;i++) if (!obj[String(i)]) obj[String(i)] = [];
    return obj;
  } catch {
    return Object.fromEntries(Array.from({length:count}, (_,i)=>[String(i+1), []]));
  }
}
const setMembers = (c, o) => `${removeBlock(c, "<!-- members:", " -->")}\n<!-- members: ${JSON.stringify(o)} -->`;
const getTitle = (c) => (between(c, "<!-- title:", " -->") || "").trim();
const setTitle = (c, t) => (t ? `${removeBlock(c, "<!-- title:", " -->")}\n<!-- title: ${t} -->` : removeBlock(c, "<!-- title:", " -->"));

// ---- buttons packed (<=5 rows, <=5 per row) ----
function buildComponentsPacked(caps) {
  const buttons = [];
  caps.forEach((_, i) => {
    buttons.push({ type: 2, style: 3, custom_id: `join_${i+1}`,  label: `加入第${han(i+1)}團` });
    buttons.push({ type: 2, style: 2, custom_id: `leave_${i+1}`, label: `離開第${han(i+1)}團` });
  });
  buttons.push({ type: 2, style: 1, custom_id: "view_all", label: "查看所有名單" });
  const rows = [];
  for (let i=0; i<buttons.length && rows.length<5; i+=5) {
    rows.push({ type: 1, components: buttons.slice(i, i+5) });
  }
  return rows;
}

// ---- labels（optional BOT_TOKEN）----
async function fetchMemberLabel(guildId, userId) {
  const token = process.env.BOT_TOKEN;
  if (!token || !guildId) return null;
  try {
    const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      headers: { Authorization: `Bot ${token}` }
    });
    if (!r.ok) return null;
    const m = await r.json();
    const base = m?.user?.global_name || m?.user?.username || `User ${userId}`;
    const nick = (m?.nick || "").trim();
    return nick ? `${base} (${nick})` : base;
  } catch { return null; }
}
async function buildSortedLabelList(guildId, ids) {
  const labels = await Promise.all(ids.map(id => fetchMemberLabel(guildId, id)));
  const list = labels.map((l,i) => l || `<@${ids[i]}>`);
  const collator = new Intl.Collator("zh-Hant", { sensitivity: "base", numeric: true });
  return list.sort((a,b) => collator.compare(a,b));
}

// ---- webhook helpers (with error logs) ----
async function patchOriginal(appId, token, body, tag="") {
  const resp = await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(()=>"<no body>");
    console.error("patch failed", tag, resp.status, txt);
  } else {
    console.log("patch ok", tag, resp.status);
  }
}
async function followup(appId, token, body, tag="") {
  const resp = await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log("followup", tag, resp.status);
}

// ===== handler =====
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

    // /cteam
    if (name === "cteam") {
      console.log("hit /cteam vA", { VERSION });
      res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

      try {
        const capsRaw   = i.data.options?.find(o=>o.name==="caps")?.value ?? "12,12,12";
        const allowMulti= i.data.options?.find(o=>o.name==="multi")?.value ?? false;
        const title     = (i.data.options?.find(o=>o.name==="title")?.value ?? "").trim();

        const caps = parseCapsInput(capsRaw);
        console.log("cteam parsed caps", caps);
        if (!caps.length || caps.length > 12) {
          await followup(i.application_id, i.token, { content: "名額格式錯誤，或團數過多（最多 12 團）。", flags: 64 }, "cteam-err-caps");
          return;
        }

        let content = buildContentFromCaps(caps);
        if (title) content = `${title}\n\n${content}`;
        content = setMulti(content, !!allowMulti);
        content = setMembers(content, Object.fromEntries(caps.map((_,idx)=>[String(idx+1), []])));
        content = setTitle(content, `${title ? title+" " : ""}[${VERSION}]`);

        await patchOriginal(i.application_id, i.token, {
          content, components: buildComponentsPacked(caps), allowed_mentions: { parse: [] }
        }, "cteam-main");
      } catch (e) {
        console.error("cteam error", e);
        await followup(i.application_id, i.token, { content: "建立訊息時發生錯誤。", flags: 64 }, "cteam-catch");
      }
      return;
    }

    // /myteams
    if (name === "myteams") {
      console.log("hit /myteams", { VERSION });
      res.status(200).json({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: 64 },
      });

      try {
        const messageId = (i.data.options?.find(o=>o.name==="message_id")?.value ?? "").trim();
        if (!messageId) {
          await patchOriginal(i.application_id, i.token, { content: `請提供 message_id。 [${VERSION}]`, flags: 64 }, "myteams-noid");
          return;
        }
        if (!process.env.BOT_TOKEN) {
          await patchOriginal(i.application_id, i.token, { content: `未設定 BOT_TOKEN。 [${VERSION}]`, flags: 64 }, "myteams-nobot");
          return;
        }
        const r = await fetch(`https://discord.com/api/v10/channels/${i.channel_id}/messages/${messageId}`, {
          headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` }
        });
        if (!r.ok) {
          await patchOriginal(i.application_id, i.token, { content: `找不到該訊息或權限不足。 [${VERSION}]`, flags: 64 }, "myteams-404");
          return;
        }
        const msg = await r.json();
        const capsNow = parseCapsFromContent(msg.content);
        const members = getMembers(msg.content, capsNow.length);
        const uid = i.member?.user?.id || i.user?.id;

        const mine = Object.entries(members).filter(([,arr]) => arr.includes(uid)).map(([k]) => parseInt(k,10));
        await patchOriginal(i.application_id, i.token, {
          content: `${mine.length ? `你目前在第 ${mine.join(", ")} 團。` : "你目前未加入任何一團。"} [${VERSION}]`,
          flags: 64
        }, "myteams-ok");
      } catch (e) {
        console.error("myteams error", e);
        await patchOriginal(i.application_id, i.token, { content: `查詢時發生錯誤。 [${VERSION}]`, flags: 64 }, "myteams-catch");
      }
      return;
    }

    // /leaveall
    if (name === "leaveall") {
      console.log("hit /leaveall", { VERSION });
      res.status(200).json({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: 64 },
      });
      try {
        await patchOriginal(i.application_id, i.token, {
          content: `請到開團訊息下方，對你所在的每團按「離開」。 [${VERSION}]`,
          flags: 64
        }, "leaveall-ok");
      } catch (e) {
        console.error("leaveall error", e);
        await patchOriginal(i.application_id, i.token, {
          content: `處理時發生錯誤。 [${VERSION}]`,
          flags: 64
        }, "leaveall-catch");
      }
      return;
    }

    // 未知指令
    console.log("unknown slash name", name);
    return res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `DEBUG unknown slash: ${name} [${VERSION}]`, flags: 64 }
    });
  }

  // 按鈕
  if (i.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = i.data?.custom_id;
    console.log("component", { customId, VERSION });

    const msg = i.message;
    const userId = i.member?.user?.id || i.user?.id;

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
            const list = ids.length ? ids.map(id => `<@${id}>`).join("、") : "（尚無成員）";
            return `${header}\n${list}`;
          }
          const list = (await buildSortedLabelList(guildId, ids)).join("、") || "（尚無成員）";
          return `${header}\n${list}`;
        })
      );

      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: parts.join("\n\n") + `\n[${VERSION}]`, flags: 64, allowed_mentions: { parse: [] } },
      });
    }

    // 其餘 join/leave
    res.status(200).json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });

    (async () => {
      try {
        const capsNow = parseCapsFromContent(msg.content);
        let multi = getMulti(msg.content);
        let members = getMembers(msg.content, capsNow.length);
        const title = getTitle(msg.content);

        const m = customId.match(/^(join|leave)_(\d+)$/);
        if (!m) { console.log("unknown component id", customId); return; }
        const action = m[1];
        const idx = parseInt(m[2], 10);

        const ids = members[String(idx)] || (members[String(idx)] = []);
        const inGroup = ids.includes(userId);

        const ep = (text, tag) => followup(i.application_id, i.token, { content: `${text} [${VERSION}]`, flags: 64, allowed_mentions:{parse:[]} }, tag);

        if (action === "join") {
          if (!multi) {
            const has = Object.values(members).some(arr => arr.includes(userId));
            if (has) return ep("你已在其他團中。", "join-has");
          }
          if (capsNow[idx - 1] <= 0) return ep("該團已滿。", "join-full");
          if (!inGroup) { ids.push(userId); capsNow[idx - 1] -= 1; } else { return ep("你已在該團。", "join-dup"); }
        } else {
          if (!inGroup) return ep("你不在該團。", "leave-notin");
          members[String(idx)] = ids.filter(x => x !== userId);
          capsNow[idx - 1] += 1;
        }

        let content = buildContentFromCaps(capsNow);
        if (title) content = `${title}\n\n${content}`;
        content = setMulti(content, multi);
        content = setMembers(content, members);
        content = setTitle(content, `${title ? title+" " : ""}[${VERSION}]`);

        await patchOriginal(i.application_id, i.token, {
          content, components: buildComponentsPacked(capsNow), allowed_mentions: { parse: [] }
        }, "component-update");
      } catch (e) {
        console.error("component error", e);
      }
    })();
    return;
  }

  // fallback — 不再回 OK，改回 DEBUG 訊息
  console.log("fallback type", i.type);
  return res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: `DEBUG fallback type=${i.type} [${VERSION}]`, flags: 64 }
  });
}
