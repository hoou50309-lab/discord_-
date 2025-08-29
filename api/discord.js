// api/discord.js — Pro version (HEAD + await verifyKey + deferred + extras)
// Features:
// - /cteam caps/multi/title/defaults（預設 12,12,12；先回 type 5 再發公開訊息）
// - Buttons: join_N / leave_N + view_all（ephemeral）
// - 名單顯示暱稱/名稱並排序（需 BOT_TOKEN；抓不到就顯示 <@id> 不會 @）
// - 內容內嵌狀態：<!-- multi:... -->、<!-- members:{...} -->、<!-- title:... -->、<!-- msg:ID -->
// - 基礎防衝突：PATCH 前（若有 BOT_TOKEN）會抓最新訊息內容，失敗短暫重試
// - /myteams [message_id]（需 BOT_TOKEN）/ leaveall（安全指引）

import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from 'discord-interactions';

// ---------- utils ----------
async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const HAN = ['零','一','二','三','四','五','六','七','八','九','十','十一','十二','十三','十四','十五','十六','十七','十八','十九','二十'];
const toHan = (n) => HAN[n] ?? String(n);

// content helpers
function parseCaps(content) {
  const lines = content.split('\n').map(s => s.trim()).filter(Boolean);
  const caps = [];
  for (const s of lines) {
    const m = s.match(/（-(\d+)）$/);
    if (m) caps.push(parseInt(m[1], 10));
  }
  return caps;
}
function buildContentFromCaps(caps) {
  return caps.map((n, i) => `第${toHan(i + 1)}團（-${n}）`).join('\n\n');
}
function buildComponents(caps) {
  const rows = caps.map((_, i) => ({
    type: 1,
    components: [
      { type: 2, style: 3, custom_id: `join_${i+1}`,  label: `加入第${toHan(i+1)}團` },
      { type: 2, style: 2, custom_id: `leave_${i+1}`, label: `離開第${toHan(i+1)}團` },
    ],
  }));
  if (rows.length === 0) rows.push({ type: 1, components: [] });
  rows[rows.length - 1].components.push({ type: 2, style: 1, custom_id: 'view_all', label: '查看所有名單' });
  return rows;
}

// embed state
function getMulti(s) {
  const m = s.match(/<!--\s*multi:(true|false)\s*-->/i);
  return m ? m[1] === 'true' : false;
}
function setMulti(s, multi) {
  const cleaned = s.replace(/<!--\s*multi:(true|false)\s*-->/i, '').trim();
  return `${cleaned}\n\n<!-- multi:${multi ? 'true' : 'false'} -->`;
}
function getMembers(s, groupCount) {
  const m = s.match(/<!--\s*members:\s*({[\s\S]*?})\s*-->/i);
  if (!m) return Object.fromEntries(Array.from({length: groupCount}, (_, i) => [String(i+1), []]));
  try {
    const obj = JSON.parse(m[1]);
    for (let i = 1; i <= groupCount; i++) if (!obj[String(i)]) obj[String(i)] = [];
    return obj;
  } catch {
    return Object.fromEntries(Array.from({length: groupCount}, (_, i) => [String(i+1), []]));
  }
}
function setMembers(s, membersObj) {
  const without = s.replace(/<!--\s*members:\s*({[\s\S]*?})\s*-->/i, '').trim();
  return `${without}\n<!-- members: ${JSON.stringify(membersObj)} -->`;
}
function getTitle(s) {
  const m = s.match(/<!--\s*title:\s*([\s\S]*?)\s*-->/i);
  return m ? m[1].trim() : '';
}
function setTitle(s, title) {
  const without = s.replace(/<!--\s*title:\s*([\s\S]*?)\s*-->/i, '').trim();
  const t = (title || '').trim();
  return t ? `${without}\n<!-- title: ${t} -->` : without;
}
function getMsgId(s) {
  const m = s.match(/<!--\s*msg:\s*(\d+)\s*-->/i);
  return m ? m[1] : '';
}
function setMsgId(s, msgId) {
  const without = s.replace(/<!--\s*msg:\s*(\d+)\s*-->/i, '').trim();
  return `${without}\n<!-- msg: ${msgId} -->`;
}

// defaults parser: "1: <@id> <@id>\n2: <@id>"
function parseDefaults(text, groups) {
  if (!text) return {};
  const out = {};
  const lines = String(text).split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s*:\s*(.*)$/);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    if (idx < 1 || idx > groups) continue;
    const ids = Array.from(m[2].matchAll(/<@!?(\d+)>/g)).map(mm => mm[1]);
    out[String(idx)] = Array.from(new Set(ids));
  }
  return out;
}

// label helpers
async function fetchMemberLabel(guildId, userId) {
  const token = process.env.BOT_TOKEN;
  if (!token || !guildId) return null;
  try {
    const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      headers: { 'Authorization': `Bot ${token}` }
    });
    if (!r.ok) return null;
    const m = await r.json();
    const base = m?.user?.global_name || m?.user?.username || `User ${userId}`;
    const nick = (m?.nick || '').trim();
    return nick ? `${base} (${nick})` : base;
  } catch {
    return null;
  }
}
async function buildSortedLabelList(guildId, ids) {
  const labels = await Promise.all(ids.map(id => fetchMemberLabel(guildId, id)));
  const filled = labels.map((label, i) => label || `<@${ids[i]}>`);
  const collator = new Intl.Collator('zh-Hant', { sensitivity: 'base', numeric: true });
  return filled.sort((a, b) => collator.compare(a, b));
}

// helpers for REST
async function fetchMessage(channelId, messageId) {
  const token = process.env.BOT_TOKEN;
  if (!token) return null;
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
    headers: { 'Authorization': `Bot ${token}` }
  });
  if (!r.ok) return null;
  return await r.json();
}
async function patchMessageWithWebhook(appId, token, messageId, body) {
  const r = await fetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/${messageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return r.ok;
}

// ---------- main handler ----------
export default async function handler(req, res) {
  if (req.method === 'HEAD') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

  const sig = req.headers['x-signature-ed25519'];
  const ts  = req.headers['x-signature-timestamp'];
  const raw = await readRawBody(req);

  const ok = await verifyKey(raw, sig, ts, process.env.PUBLIC_KEY);
  if (!ok) { res.status(401).send('invalid request signature'); return; }

  const i = JSON.parse(raw);

  // PING
  if (i.type === InteractionType.PING) {
    return res.status(200).json({ type: InteractionResponseType.PONG });
  }

  // Slash commands
  if (i.type === InteractionType.APPLICATION_COMMAND) {
    const name = i.data?.name;

    // ---------- /cteam ----------
    if (name === 'cteam') {
      // Immediately defer (type 5)
      res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

      const capsRaw    = i.data.options?.find(o => o.name === 'caps')?.value ?? '12,12,12';
      const allowMulti = i.data.options?.find(o => o.name === 'multi')?.value ?? false;
      const title      = (i.data.options?.find(o => o.name === 'title')?.value ?? '').trim();
      const defaultsTx = (i.data.options?.find(o => o.name === 'defaults')?.value ?? '').trim();

      const caps = String(capsRaw).split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n >= 0);
      if (!caps.length || caps.length * 2 > 25) {
        await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: '名額格式錯誤或團數過多（最多 12 團）。', flags: 64 })
        });
        return;
      }

      // Build initial state
      let content = buildContentFromCaps(caps);
      if (title) content = `${title}\n\n${content}`;
      content = setMulti(content, !!allowMulti);

      // members with defaults
      let members = Object.fromEntries(caps.map((_, idx) => [String(idx+1), []]));
      const preset = parseDefaults(defaultsTx, caps.length);
      for (const k of Object.keys(preset)) {
        const idx = parseInt(k, 10);
        const ids = preset[k];
        for (const uid of ids) {
          if (!members[k].includes(uid)) {
            members[k].push(uid);
            if (caps[idx-1] > 0) caps[idx-1] -= 1;
          }
        }
      }
      content = setMembers(content, members);
      content = setTitle(content, title);

      // Post the message as follow-up (wait to get id)
      const follow = await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          components: buildComponents(caps),
          allowed_mentions: { parse: [] }
        })
      }).then(r => r.json()).catch(() => null);

      if (!follow?.id) return;

      // Append msg id metadata
      const withMsg = setMsgId(content, follow.id);
      await patchMessageWithWebhook(i.application_id, i.token, follow.id, { content: withMsg });
      return;
    }

    // ---------- /myteams ----------
    if (name === 'myteams') {
      const targetId = (i.data.options?.find(o => o.name === 'message_id')?.value ?? '').trim();
      if (!targetId) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '請提供 message_id（在訊息「更多」→ 複製連結），或直接在開團訊息下方點「查看所有名單」。', flags: 64 }
        });
      }
      if (!process.env.BOT_TOKEN) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '系統未設定 BOT_TOKEN，無法讀取指定訊息。請改用「查看所有名單」按鈕。', flags: 64 }
        });
      }
      const msg = await fetchMessage(i.channel_id, targetId);
      if (!msg) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '找不到該訊息，或我沒有權限讀取。', flags: 64 }
        });
      }
      const capsNow = parseCaps(msg.content);
      const members = getMembers(msg.content, capsNow.length);
      const uid = i.member?.user?.id || i.user?.id;
      const my = Object.entries(members).filter(([, arr]) => arr.includes(uid)).map(([k]) => parseInt(k, 10));
      const reply = my.length ? `你目前在第 ${my.join(', ')} 團。` : '你目前未加入任何一團。';
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: reply, flags: 64 }
      });
    }

    // ---------- /leaveall ----------
    if (name === 'leaveall') {
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: '請到開團訊息下方，對你所在的每團按下「離開」。這樣最安全、也能避免編輯衝突。', flags: 64 }
      });
    }
  }

  // Component interactions (buttons)
  if (i.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = i.data?.custom_id;
    const message  = i.message;
    const userId   = i.member?.user?.id || i.user?.id;
    const guildId  = i.guild_id;

    if (customId === 'view_all') {
      const capsNow = parseCaps(message.content);
      const members = getMembers(message.content, capsNow.length);
      const parts = await Promise.all(capsNow.map(async (n, idx) => {
        const ids = members[String(idx+1)] || [];
        const title = `第${toHan(idx+1)}團名單（${ids.length} 人）`;
        if (!ids.length || !guildId || !process.env.BOT_TOKEN) {
          const list = ids.length ? ids.map(id => `<@${id}>`).join('、') : '（尚無成員）';
          return `${title}\n${list}`;
        }
        const labels = await buildSortedLabelList(guildId, ids);
        const list = labels.length ? labels.join('、') : '（尚無成員）';
        return `${title}\n${list}`;
      }));

      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: parts.join('\n\n'), flags: 64, allowed_mentions: { parse: [] } }
      });
    }

    // defer update
    res.status(200).json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });

    // conflict mitigation: fetch latest message content with BOT_TOKEN if possible
    let currentContent = message.content;
    const msgId = getMsgId(message.content) || message.id;
    if (process.env.BOT_TOKEN) {
      const refreshed = await fetchMessage(i.channel_id, msgId);
      if (refreshed?.content) currentContent = refreshed.content;
    }

    (async () => {
      try {
        const capsNow = parseCaps(currentContent);
        const groupCount = capsNow.length;
        let multi   = getMulti(currentContent);
        let members = getMembers(currentContent, groupCount);
        const title = getTitle(currentContent);

        const m = customId.match(/^(join|leave)_(\d+)$/);
        if (!m) return;
        const action = m[1];
        const idx    = parseInt(m[2], 10);

        const myGroups = Object.entries(members).filter(([, arr]) => Array.isArray(arr) && arr.includes(userId)).map(([k]) => parseInt(k, 10));

        async function ephemeral(msg) {
          await fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: msg, flags: 64, allowed_mentions: { parse: [] } })
          });
        }

        if (action === 'join') {
          if (!multi && myGroups.length > 0) { await ephemeral(`你已在第 ${myGroups.join(', ')} 團。`); return; }
          if (capsNow[idx - 1] <= 0) { await ephemeral('該團已滿，無法加入。'); return; }
          const arr = members[String(idx)];
          if (!arr.includes(userId)) { arr.push(userId); capsNow[idx - 1] -= 1; }
          else { await ephemeral('你已在該團中。'); return; }
        }

        if (action === 'leave') {
          const arr = members[String(idx)];
          const pos = arr.indexOf(userId);
          if (pos === -1) { await ephemeral('你不在該團中。'); return; }
          arr.splice(pos, 1); capsNow[idx - 1] += 1;
        }

        let newContent = buildContentFromCaps(capsNow);
        if (title) newContent = `${title}\n\n${newContent}`;
        newContent = setMulti(newContent, multi);
        newContent = setMembers(newContent, members);
        newContent = setTitle(newContent, title);
        newContent = setMsgId(newContent, msgId);

        // retry a couple of times
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          ok = await patchMessageWithWebhook(i.application_id, i.token, msgId, {
            content: newContent,
            components: buildComponents(capsNow),
            allowed_mentions: { parse: [] }
          });
          if (!ok) await new Promise(r => setTimeout(r, 120));
        }
      } catch (e) {
        console.error('component error', e);
      }
    })();

    return;
  }

  // Fallback
  return res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: '未處理的互動類型。', flags: 64 }
  });
}
