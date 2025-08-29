// api/discord.js
// 無常駐：僅處理 Discord HTTP Interactions（slash 指令 + 按鈕）
// 依賴：npm i discord-interactions

import { InteractionType, InteractionResponseType, verifyKey } from 'discord-interactions';

// 讀取原始請求 Body（字串），用於驗簽
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const hanMap = ['零','一','二','三','四','五','六','七','八','九','十','十一','十二','十三','十四','十五','十六','十七','十八','十九','二十'];
const numToHan = (n) => hanMap[n] ?? String(n);

// 解析團數：偵測結尾「（-數字）」
function parseGroupsFromContent(content) {
  const lines = content.split('\n').map(s => s.trim()).filter(Boolean);
  const caps = [];
  for (const s of lines) {
    if (!s.endsWith('）')) continue;
    const p = s.lastIndexOf('（-');
    if (p === -1) continue;
    const numStr = s.slice(p + 2, s.length - 1);
    const n = parseInt(numStr, 10);
    if (Number.isFinite(n)) caps.push(n);
  }
  return caps;
}

// 顯示格式：第X團（-n）
function buildContentFromCaps(caps) {
  return caps.map((n, i) => `第${numToHan(i + 1)}團（-${n}）`).join('\n\n');
}
// 每團兩個按鈕：加入/離開；最後一列再加「查看所有名單 / 主揪：踢人 / 主揪：移組」
function buildComponents(caps) {
  const rows = caps.map((_, i) => ({
    type: 1, // Action Row
    components: [
      { type: 2, style: 3, custom_id: `join_${i + 1}`,  label: `加入第${numToHan(i + 1)}團` },
      { type: 2, style: 2, custom_id: `leave_${i + 1}`, label: `離開第${numToHan(i + 1)}團` },
    ],
  }));
  if (rows.length === 0) rows.push({ type: 1, components: [] });
  rows[rows.length - 1].components.push(
    { type: 2, style: 1, custom_id: 'view_all',  label: '查看所有名單' },
    { type: 2, style: 1, custom_id: 'kick_open', label: '主揪：踢人' },
    { type: 2, style: 1, custom_id: 'move_open', label: '主揪：移組' },
  );
  return rows;
}

// ===== 狀態註解（multi/members/title/owner/ver）=====
function pickComment(content, key) {
  const tag = `<!-- ${key}:`;
  const i = content.indexOf(tag);
  if (i < 0) return null;
  const j = content.indexOf('-->', i);
  if (j < 0) return null;
  return { i, j, value: content.slice(i + tag.length, j).trim() };
}
function stripComment(content, key) {
  const tag = `<!-- ${key}:`;
  const i = content.indexOf(tag);
  if (i < 0) return content.trim();
  const j = content.indexOf('-->', i);
  if (j < 0) return content.slice(0, i).trim();
  return (content.slice(0, i) + content.slice(j + 3)).trim();
}

function getMultiFromContent(content) { const p = pickComment(content, 'multi'); return p ? p.value === 'true' : false; }
function setMultiInContent(content, multi) { return `${stripComment(content,'multi')}\n\n<!-- multi:${multi ? 'true' : 'false'} -->`; }

function getMembersFromContent(content, groupCount) {
  const p = pickComment(content, 'members');
  if (!p) return Object.fromEntries(Array.from({ length: groupCount }, (_, i) => [String(i+1), []]));
  try {
    const obj = JSON.parse(p.value);
    for (let i=1;i<=groupCount;i++) if (!obj[String(i)]) obj[String(i)] = [];
    return obj;
  } catch { return Object.fromEntries(Array.from({ length: groupCount }, (_, i) => [String(i+1), []])); }
}
function setMembersInContent(content, membersObj) { return `${stripComment(content,'members')}\n<!-- members: ${JSON.stringify(membersObj)} -->`; }

function getTitleFromContent(content) { const p = pickComment(content,'title'); return p ? p.value : ''; }
function setTitleInContent(content, title) { const t = (title ?? '').trim(); const s = stripComment(content,'title'); return t ? `${s}\n<!-- title: ${t} -->` : s; }
function getOwnerFromContent(content) { const p = pickComment(content,'owner'); return p ? p.value : ''; }
function setOwnerInContent(content, ownerId) { return `${stripComment(content,'owner')}\n<!-- owner: ${ownerId} -->`; }
function getVerFromContent(content) { const p = pickComment(content,'ver'); const v = p?parseInt(p.value,10):0; return Number.isFinite(v)?v:0; }
function setVerInContent(content, ver) { return `${stripComment(content,'ver')}\n<!-- ver: ${ver} -->`; }

const PUBLIC_KEY = process.env.PUBLIC_KEY;
const BOT_TOKEN  = process.env.BOT_TOKEN; // 查詢成員暱稱/名稱、讀最新訊息（防衝突）
// 以 BOT Token 取回成員顯示名稱（優先 nick，其次 global_name，再 username）
async function fetchMemberLabel(guildId, userId) {
  try {
    if (!BOT_TOKEN) return null;
    const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, { headers: { 'Authorization': `Bot ${BOT_TOKEN}` } });
    if (!r.ok) return null;
    const m = await r.json();
    const base = m?.user?.global_name || m?.user?.username || `User ${userId}`;
    const nick = (m?.nick || '').trim();
    return nick ? `${base} (${nick})` : base;
  } catch { return null; }
}

// 將一串 userId 轉為排序後的顯示名稱陣列
async function buildSortedLabelList(guildId, ids) {
  const labels = await Promise.all(ids.map(id => fetchMemberLabel(guildId, id)));
  const filled = labels.map((label, i) => label || `<@${ids[i]}>`);
  const collator = new Intl.Collator('zh-Hant', { sensitivity: 'base', numeric: true });
  return filled.sort((a, b) => collator.compare(a, b));
}

// 讀最新訊息（避免衝突）
async function fetchLatestMessage(channelId, messageId) {
  if (!BOT_TOKEN) return null;
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, { headers: { 'Authorization': `Bot ${BOT_TOKEN}` } });
  if (!r.ok) return null;
  return r.json();
}
// 套用變更（mutator）到最新狀態再 PATCH（簡易樂觀鎖）
async function applyAndPatch({ interaction, baseMessage, mutator }) {
  try {
    const channelId = interaction.channel_id;
    const messageId = baseMessage.id;
    const latest = await fetchLatestMessage(channelId, messageId);
    const contentNow = latest?.content ?? baseMessage.content;

    const capsNow = parseGroupsFromContent(contentNow);
    const groupCount = capsNow.length;
    let multi   = getMultiFromContent(contentNow);
    let members = getMembersFromContent(contentNow, groupCount);
    const title = getTitleFromContent(contentNow);
    const owner = getOwnerFromContent(contentNow);
    const ver   = getVerFromContent(contentNow);

    const ok = await mutator({ capsNow, members, title, owner, multi });
    if (!ok) return false;

    let newContent = buildContentFromCaps(capsNow);
    if (title) newContent = `${title}\n\n${newContent}`;
    newContent = setMultiInContent(newContent, multi);
    newContent = setMembersInContent(newContent, members);
    newContent = setTitleInContent(newContent, title);
    newContent = setOwnerInContent(newContent, owner);
    newContent = setVerInContent(newContent, ver + 1);

    await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: newContent, components: buildComponents(capsNow), allowed_mentions: { parse: [] } })
    });
    return true;
  } catch (e) {
    console.error('applyAndPatch error', e);
    return false;
  }
}

// 以 BOT Token 直接讀/寫指定 message（for message_id 綁定）
async function fetchMessageById(channelId, messageId) {
  if (!BOT_TOKEN) return null;
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, { headers: { 'Authorization': `Bot ${BOT_TOKEN}` } });
  if (!r.ok) return null;
  return r.json();
}
async function patchMessageById(channelId, messageId, { content, components }) {
  if (!BOT_TOKEN) throw new Error('BOT_TOKEN required to patch message by id');
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH', headers: { 'Authorization': `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, components, allowed_mentions: { parse: [] } })
  });
  return r.ok;
}
// 對特定 messageId 做樂觀合併更新（不依賴 webhook token）
async function applyAndPatchToMessageId({ interaction, channelId, messageId, mutator }) {
  try {
    const latest = await fetchLatestMessage(channelId, messageId);
    if (!latest) return false;
    const contentNow = latest.content;

    const capsNow = parseGroupsFromContent(contentNow);
    const groupCount = capsNow.length;
    let multi   = getMultiFromContent(contentNow);
    let members = getMembersFromContent(contentNow, groupCount);
    const title = getTitleFromContent(contentNow);
    const owner = getOwnerFromContent(contentNow);
    const ver   = getVerFromContent(contentNow);

    const ok = await mutator({ capsNow, members, title, owner, multi });
    if (!ok) return false;

    let newContent = buildContentFromCaps(capsNow);
    if (title) newContent = `${title}\n\n${newContent}`;
    newContent = setMultiInContent(newContent, multi);
    newContent = setMembersInContent(newContent, members);
    newContent = setTitleInContent(newContent, title);
    newContent = setOwnerInContent(newContent, owner);
    newContent = setVerInContent(newContent, ver + 1);

    await patchMessageById(channelId, messageId, { content: newContent, components: buildComponents(capsNow) });
    return true;
  } catch (e) {
    console.error('applyAndPatchToMessageId error', e);
    return false;
  }
}
// ====== 預設成員（Preset）處理 ======
function parseDefaultMapFromText(text) {
  const out = {};
  if (!text) return out;
  for (const raw of text.split(/\n|;/).map(s => s.trim()).filter(Boolean)) {
    const m = raw.match(/^(\d+)\s*[:：]\s*(.+)$/);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    const ids = Array.from(m[2].matchAll(/\d{8,}/g)).map(x => x[0]);
    if (ids.length) out[idx] = Array.from(new Set(ids));
  }
  return out;
}
async function parseDefaultMapFromAttachment(interaction, attachId) {
  try {
    const a = interaction.data?.resolved?.attachments?.[attachId];
    if (!a?.url) return {};
    const r = await fetch(a.url);
    const text = await r.text();
    if (/\.json$/i.test(a.filename) || /^\s*[{[]/.test(text)) {
      const obj = JSON.parse(text);
      const out = {};
      for (const [k,v] of Object.entries(obj)) out[parseInt(k,10)] = Array.from(new Set(v.map(String)));
      return out;
    }
    // CSV
    const lines = text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    const out = {};
    for (const line of lines) {
      const parts = line.split(/[ ,\t]+/).map(s=>s.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      const g = parseInt(parts[0],10);
      const uid = parts[1].match(/\d{8,}/)?.[0];
      if (!Number.isFinite(g) || !uid) continue;
      if (!out[g]) out[g] = [];
      out[g].push(uid);
    }
    for (const k of Object.keys(out)) out[k] = Array.from(new Set(out[k]));
    return out;
  } catch { return {}; }
}
function applyPresetMembers({ caps, allowMulti, presetMap }) {
  const groupCount = caps.length;
  const members = Object.fromEntries(caps.map((_,i)=>[String(i+1),[]]));
  const capsLeft = caps.slice();
  const seen = new Set();
  for (let i=1; i<=groupCount; i++) {
    const want = Array.from(new Set(presetMap[i] || []));
    for (const uid of want) {
      if (capsLeft[i-1] <= 0) continue;
      if (!allowMulti && seen.has(uid)) continue;
      if (!members[String(i)].includes(uid)) {
        members[String(i)].push(uid);
        capsLeft[i-1] -= 1;
        seen.add(uid);
      }
    }
  }
  return { members, capsLeft };
}
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  // 驗簽（需要原始字串）
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const rawBody = await readRawBody(req);

  const isValid = verifyKey(rawBody, signature, timestamp, PUBLIC_KEY);
  if (!isValid) {
    res.status(401).send('invalid request signature');
    return;
  }

  const interaction = JSON.parse(rawBody);

  // 1) PING
  if (interaction.type === InteractionType.PING) {
    return res.status(200).json({ type: InteractionResponseType.PONG });
  }

  // 2) Slash 指令：/cteam /myteams /leaveall（皆用 type:5 先回覆）
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const name = interaction.data.name;

    if (name === 'cteam') {
      // 先回 type:5（thinking...），再編輯原訊息建立團隊貼文
      res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

      (async () => {
        const opt = Object.fromEntries((interaction.data.options || []).map(o => [o.name, o.value]));
        const capsRaw    = opt.caps ?? '12,12,12'; // 預設改為 12,12,12
        const allowMulti = !!opt.multi;
        const title      = (opt.title ?? '').trim();
        const defaults   = (opt.defaults ?? '').trim();
        const presetId   = opt.preset_file; // attachment snowflake id

        const caps = String(capsRaw)
          .split(',')
          .map(s => parseInt(s.trim(), 10))
          .filter(n => Number.isInteger(n) && n >= 0);

        if (caps.length === 0 || caps.length > 5) {
          const msg = caps.length === 0 ? '名額格式錯誤，請用逗號分隔的非負整數，例如：12,12,12' : '團數過多（最多 5 團，因按鈕列限制）。';
          await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: msg, allowed_mentions: { parse: [] } })
          });
          return;
        }

        // 先組預設成員表
        let presetMap = {};
        if (presetId) {
          const m = await parseDefaultMapFromAttachment(interaction, presetId);
          Object.assign(presetMap, m);
        }
        if (defaults) {
          const m = parseDefaultMapFromText(defaults);
          for (const [k,v] of Object.entries(m)) if (!presetMap[k]) presetMap[k] = v; // 檔案優先，文字補空
        }

        // 建立初始 members & 扣名額
        let initMembers = Object.fromEntries(caps.map((_, i) => [String(i+1), []]));
        let capsUse = caps.slice();
        if (Object.keys(presetMap).length) {
          const { members, capsLeft } = applyPresetMembers({ caps, allowMulti, presetMap });
          initMembers = members;
          capsUse = capsLeft;
        }

        let content = buildContentFromCaps(capsUse);
        if (title) content = `${title}\n\n${content}`;
        content = setMultiInContent(content, allowMulti);
        content = setMembersInContent(content, initMembers);
        content = setTitleInContent(content, title);
        content = setOwnerInContent(content, interaction.member?.user?.id || interaction.user?.id || '');
        content = setVerInContent(content, 1);

        await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, components: buildComponents(capsUse), allowed_mentions: { parse: [] } })
        });
      })();
      return;
    }

    if (name === 'myteams') {
      // 先回 type:5（ephemeral thinking...）
      res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64 } });

      (async () => {
        try {
          const opt = Object.fromEntries((interaction.data.options || []).map(o => [o.name, o.value]));
          const channelId = interaction.channel_id;
          const messageIdOpt = (opt.message_id || '').trim();

          let msg = null;
          if (messageIdOpt) {
            msg = await fetchMessageById(channelId, messageIdOpt);
          } else if (BOT_TOKEN) {
            const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=50`, { headers: { 'Authorization': `Bot ${BOT_TOKEN}` } });
            const arr = await r.json();
            msg = arr.find(m => typeof m.content === 'string' && /<!--\s*members:\s*\{/.test(m.content));
          }

          if (!msg) {
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: messageIdOpt ? '找不到指定 message_id 的開團訊息。' : '找不到開團訊息（請在同一頻道使用或提供 message_id）。', allowed_mentions: { parse: [] } })
            });
            return;
          }

          const capsNow = parseGroupsFromContent(msg.content);
          const members = getMembersFromContent(msg.content, capsNow.length);
          const me = interaction.member?.user?.id || interaction.user?.id;
          const list = Object.entries(members).filter(([,ids]) => ids.includes(me)).map(([k]) => `第${numToHan(parseInt(k,10))}團`);
          const title = getTitleFromContent(msg.content);
          const text = list.length ? `你參與：${list.join('、')}${title?`\n標題：${title}`:''}` : '你目前不在任何團。';

          await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } })
          });
        } catch {
          await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: '查詢失敗，請稍後再試。', allowed_mentions: { parse: [] } })
          });
        }
      })();
      return;
    }

    if (name === 'leaveall') {
      // 先回 type:5（ephemeral thinking...）
      res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64 } });

      (async () => {
        try {
          const opt = Object.fromEntries((interaction.data.options || []).map(o => [o.name, o.value]));
          const channelId = interaction.channel_id;
          const messageIdOpt = (opt.message_id || '').trim();

          let msg = null;
          if (messageIdOpt) {
            msg = await fetchMessageById(channelId, messageIdOpt);
          } else if (BOT_TOKEN) {
            const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=50`, { headers: { 'Authorization': `Bot ${BOT_TOKEN}` } });
            const arr = await r.json();
            msg = arr.find(m => typeof m.content === 'string' && /<!--\s*members:\s*\{/.test(m.content));
          }
          if (!msg) {
            await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: messageIdOpt ? '找不到指定 message_id 的開團訊息。' : '找不到開團訊息（請在同一頻道使用或提供 message_id）。', allowed_mentions: { parse: [] } })
            });
            return;
          }

          const me = interaction.member?.user?.id || interaction.user?.id;
          const ok = await applyAndPatchToMessageId({ interaction, channelId, messageId: msg.id, mutator: ({ capsNow, members }) => {
            let changed = false;
            for (const [k, ids] of Object.entries(members)) {
              const i = ids.indexOf(me);
              if (i >= 0) { ids.splice(i,1); capsNow[parseInt(k,10)-1] += 1; changed = true; }
            }
            return changed;
          }});
          const text = ok ? '已為你退出此開團內的所有團。' : '沒有需要變更的項目，或發生錯誤。';
          await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } })
          });
        } catch {
          await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: '操作失敗，請稍後再試。', allowed_mentions: { parse: [] } })
          });
        }
      })();
      return;
    }
  }

  // 3) 按鈕/選單互動
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = interaction.data.custom_id; // join_1 / leave_1 / view_all / kick_* / move_*
    const message  = interaction.message;        // 原訊息（含 content）
    const userId   = interaction.member?.user?.id || interaction.user?.id;

    // 「查看所有名單」→ 直接回 ephemeral，不做 defer
    if (customId === 'view_all') {
      const guildId = interaction.guild_id;
      const capsNow = parseGroupsFromContent(message.content);
      const members = getMembersFromContent(message.content, capsNow.length);
      const parts = await Promise.all(capsNow.map(async (n, i) => {
        const ids = members[String(i+1)] || [];
        const title = `第${numToHan(i+1)}團名單（共 ${ids.length} 人）`;
        if (!BOT_TOKEN || !guildId || ids.length === 0) {
          const list = ids.length ? ids.map(id => `<@${id}>`).join('、') : '（尚無成員）';
          return `${title}\n${list}`;
        }
        const labels = await buildSortedLabelList(guildId, ids);
        const list = labels.length ? labels.join('、') : '（尚無成員）';
        return `${title}\n${list}`;
      }));
      return res.status(200).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: parts.join('\n\n'), flags: 64 } });
    }

    // 主揪檢查（踢人/移組流程）
    if (customId === 'kick_open' || customId === 'move_open' || customId.startsWith('kick_pick_') || customId.startsWith('move_pick_')) {
      const owner = getOwnerFromContent(message.content);
      if (!owner || owner !== userId) {
        return res.status(200).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: '只有主揪可以使用這些管理功能。', flags: 64 } });
      }
    }

    // 踢人：選團 → 選成員 → 執行
    if (customId === 'kick_open') {
      const capsNow = parseGroupsFromContent(message.content);
      const members = getMembersFromContent(message.content, capsNow.length);
      const options = Object.entries(members).filter(([,ids])=>ids.length>0).map(([k,ids])=>({ label:`第${numToHan(parseInt(k,10))}團（${ids.length}人）`, value:k }));
      if (options.length === 0) return res.status(200).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content:'目前沒有可踢除的成員。', flags:64 } });
      return res.status(200).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { flags:64, content:'選擇要操作的團：', components:[{ type:1, components:[{ type:3, custom_id:'kick_pick_group', placeholder:'選擇團', options }]}] } });
    }
    if (customId === 'kick_pick_group') {
      const idx = parseInt(interaction.data.values?.[0]||'0',10);
      const members = getMembersFromContent(message.content, parseGroupsFromContent(message.content).length);
      const ids = members[String(idx)] || [];
      if (ids.length === 0) return res.status(200).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data:{ content:'這團沒有成員。', flags:64 } });
      const options = ids.slice(0,25).map(uid=>({ label:`成員 ${uid}`, value:`${idx}:${uid}` }));
      return res.status(200).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { flags:64, content:`選擇要踢出的成員（第${numToHan(idx)}團）：`, components:[{ type:1, components:[{ type:3, custom_id:'kick_pick_member', placeholder:'選擇成員', options }]}] } });
    }
    if (customId === 'kick_pick_member') {
      const val = interaction.data.values?.[0] || '';
      const [idxStr, uid] = val.split(':');
      const idx = parseInt(idxStr,10);
      const ok = await applyAndPatch({ interaction, baseMessage: message, mutator: ({ capsNow, members }) => {
        const arr = members[String(idx)] || [];
        const pos = arr.indexOf(uid);
        if (pos === -1) return false;
        arr.splice(pos,1); capsNow[idx-1]+=1; return true;
      }});
      const text = ok ? `已踢出 <@${uid}>（第${numToHan(idx)}團）。` : '操作失敗或無變更。';
      return res.status(200).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data:{ content:text, flags:64 } });
    }

    // 移組：選來源團 → 選成員 → 選目的團 → 執行
    if (customId === 'move_open') {
      const capsNow = parseGroupsFromContent(message.content);
      const members = getMembersFromContent(message.content, capsNow.length);
      const options = Object.entries(members).filter(([,ids])=>ids.length>0).map(([k,ids])=>({ label:`來源：第${numToHan(parseInt(k,10))}團（${ids.length}人）`, value:k }));
      if (options.length === 0) return res.status(200).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content:'目前沒有可移動的成員。', flags:64 } });
      return res.status(200).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { flags:64, content:'選擇來源團：', components:[{ type:1, components:[{ type:3, custom_id:'move_pick_src', placeholder:'選擇來源團', options }]}] } });
    }
    if (customId === 'move_pick_src') {
      const src = parseInt(interaction.data.values?.[0]||'0',10);
      const members = getMembersFromContent(message.content, parseGroupsFromContent(message.content).length);
      const ids = members[String(src)] || [];
      if (ids.length === 0) return res.status(200).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data:{ content:'這團沒有成員。', flags:64 } });
      const options = ids.slice(0,25).map(uid=>({ label:`成員 ${uid}`, value:`${src}:${uid}` }));
      return res.status(200).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { flags:64, content:`選擇要移動的成員（第${numToHan(src)}團）：`, components:[{ type:1, components:[{ type:3, custom_id:'move_pick_member', placeholder:'選擇成員', options }]}] } });
    }
    if (customId === 'move_pick_member') {
      const val = interaction.data.values?.[0] || '';
      const [srcStr, uid] = val.split(':');
      const src = parseInt(srcStr,10);
      const total = parseGroupsFromContent(message.content).length;
      const options = Array.from({length: total}, (_,i)=>i+1).filter(n=>n!==src).map(n=>({ label:`移至：第${numToHan(n)}團`, value:`${src}:${uid}:${n}` }));
      return res.status(200).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { flags:64, content:'選擇目的團：', components:[{ type:1, components:[{ type:3, custom_id:'move_pick_dest', placeholder:'選擇目的團', options }]}] } });
    }
    if (customId === 'move_pick_dest') {
      const val = interaction.data.values?.[0] || '';
      const [srcStr, uid, dstStr] = val.split(':');
      const src = parseInt(srcStr,10), dst = parseInt(dstStr,10);
      const ok = await applyAndPatch({ interaction, baseMessage: message, mutator: ({ capsNow, members, multi }) => {
        const srcArr = members[String(src)] || [];
        const dstArr = members[String(dst)] || [];
        const pos = srcArr.indexOf(uid);
        if (pos === -1) return false;
        if (capsNow[dst-1] <= 0) return false; // 目的名額不足
        if (!multi && dstArr.includes(uid)) return false; // 不允許多團
        srcArr.splice(pos,1); capsNow[src-1]+=1;
        dstArr.push(uid);     capsNow[dst-1]-=1;
        return true;
      }});
      const text = ok ? `已將 <@${uid}> 自第${numToHan(src)}團移至第${numToHan(dst)}團。` : '操作失敗（可能名額不足、成員不在來源團或已在目的團）。';
      return res.status(200).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data:{ content:text, flags:64 } });
    }

    // 加入/離開 → 先 defer，再由 applyAndPatch 防衝突更新
    const m = customId.match(/^(join|leave)_(\d+)$/);
    if (m) {
      res.status(200).json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE }); // thinking...
      (async () => {
        const action = m[1];
        const idx = parseInt(m[2], 10);
        const me = userId;
        await applyAndPatch({ interaction, baseMessage: message, mutator: ({ capsNow, members, multi }) => {
          const myGroups = Object.entries(members).filter(([,arr])=>Array.isArray(arr) && arr.includes(me)).map(([k])=>parseInt(k,10));
          if (action === 'join') {
            if (!multi && myGroups.length>0) return false;
            if (capsNow[idx-1] <= 0) return false;
            if (!members[String(idx)].includes(me)) { members[String(idx)].push(me); capsNow[idx-1]-=1; return true; }
            return false;
          } else {
            const arr = members[String(idx)];
            const pos = arr.indexOf(me);
            if (pos === -1) return false;
            arr.splice(pos,1); capsNow[idx-1]+=1; return true;
          }
        }});
      })();
      return;
    }

    // 其他無效按鈕
    return res.status(200).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data:{ content:'無效的操作。', flags:64 } });
  }

  // 其他型別
  return res.status(200).json({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { content: '未處理的互動類型。', flags: 64 } });
}
