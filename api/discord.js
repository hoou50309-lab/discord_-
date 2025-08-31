// api/discord.js
// 穩定版 + 管理選單（踢人 / 移組）+ 修正重複貼訊息 + 原始 token 綁定 + Bot Token 後援 + defaults_file/CSV
// - /cteam 同步回覆（type:4）
// - join/leave：快速路徑 2.2s 內直接 UPDATE_MESSAGE（type:7），否則走 defer+PATCH
// - admin_open / admin_manage:* 直接回覆 ephemeral（type:4, flags:64）→ 點了就有反應
// - 狀態優先 Redis（UPSTASH_REDIS_REST_URL/TOKEN），無則記憶體
// - VERIFY_SIGNATURE 預設依環境：Production=true、其餘=false（可被環境變數覆寫）
// - ★ Discord 健康檢查可用 HEAD/GET/OPTIONS：一律 200（不驗簽）
// - ★ 管理選單選項顯示暱稱/顯示名稱（需要 BOT_TOKEN；自動快取 24h）
// - ★ 按鈕改為「兩團同一行」：最多 5 行，每行最多 5 元件 → 最多支援 10 團 + 1 管理鍵

import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from 'discord-interactions'

/* =========================
 * 環境與開關
 * ========================= */
const _resolvedVerify =
  (process.env.VERIFY_SIGNATURE ??
   ((process.env.VERCEL === '1' ||
     process.env.VERCEL_ENV === 'production' ||
     process.env.NODE_ENV === 'production')
     ? 'true'
     : 'false'));
const VERIFY_SIGNATURE = String(_resolvedVerify).toLowerCase() === 'true';

const PUBLIC_KEY = process.env.PUBLIC_KEY || '';

const APP_ID = process.env.APP_ID || '';
const BOT_TOKEN = process.env.BOT_TOKEN || '';

const RURL = process.env.UPSTASH_REDIS_REST_URL || '';
const RTOK = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const HAVE_REDIS = !!(RURL && RTOK);

// 快速路徑參數
const FAST_UPDATE = true;
const LOCK_TTL_SEC = 2;
const FAST_TIMEOUT_MS = 2200;

/* =========================
 * 小工具/基礎
 * ========================= */
const memKV = new Map();
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function redisFetch(path) {
  const url = `${RURL}/${path}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${RTOK}` },
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`redis ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}
async function kvSet(key, val, ttlSec) {
  if (HAVE_REDIS) {
    const enc = encodeURIComponent;
    const b64 = Buffer.from(JSON.stringify(val)).toString('base64');
    const path = ttlSec ? `SET/${enc(key)}/${enc(b64)}?EX=${ttlSec}` : `SET/${enc(key)}/${enc(b64)}`;
    await redisFetch(path);
  } else {
    memKV.set(key, { val, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
  }
}
async function kvGet(key) {
  if (HAVE_REDIS) {
    const enc = encodeURIComponent;
    const j = await redisFetch(`GET/${enc(key)}`);
    if (!j || j.result == null) return null;
    try { return JSON.parse(Buffer.from(j.result, 'base64').toString('utf8')); } catch { return null; }
  } else {
    const it = memKV.get(key);
    if (!it) return null;
    if (it.exp && Date.now() > it.exp) { memKV.delete(key); return null; }
    return it.val;
  }
}
async function kvDel(key) {
  if (HAVE_REDIS) {
    const enc = encodeURIComponent;
    await redisFetch(`DEL/${enc(key)}`);
  } else {
    memKV.delete(key);
  }
}
async function withLock(lockKey, ttlSec, fn) {
  const enc = encodeURIComponent;
  const key = `lock:${lockKey}`;
  const val = String(Date.now());
  if (HAVE_REDIS) {
    let ok = false;
    try {
      const r = await redisFetch(`SETNX/${enc(key)}/${enc(val)}`);
      ok = !!r?.result;
    } catch (_) {}
    if (!ok) throw new Error('lock busy');
    try { await redisFetch(`EXPIRE/${enc(key)}/${ttlSec}`); } catch {}
    try { return await fn(); }
    finally { try { await redisFetch(`DEL/${enc(key)}`); } catch {} }
  } else {
    if (memKV.has(key)) throw new Error('lock busy');
    memKV.set(key, { val, exp: Date.now() + ttlSec * 1000 });
    try { return await fn(); }
    finally { memKV.delete(key); }
  }
}

/* =========================
 * 附件處理：讀取 / CSV 轉換
 * ========================= */
function getAttachment(interaction, optName) {
  const opt = interaction?.data?.options?.find(o => o.name === optName);
  if (!opt) return null;
  const id = opt.value;
  return interaction?.data?.resolved?.attachments?.[id] || null;
}
async function readAttachmentText(att, maxBytes = 200 * 1024) {
  try {
    if (!att?.url) return null;
    if (att.size && att.size > maxBytes) return null;
    const r = await fetch(att.url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}
function csvToDefaults(csvText) {
  const lines = String(csvText || "").trim().split(/\r?\n/);
  if (!lines.length) return "";
  const outMap = new Map();
  let start = 0;
  const h = (lines[0] || "").toLowerCase();
  if (h.includes("group") && (h.includes("member") || h.includes("id"))) start = 1;

  for (let i = start; i < lines.length; i++) {
    const row = lines[i].trim();
    if (!row) continue;
    const parts = row.split(",").map(s => s.trim());
    if (parts.length < 2) continue;
    const g = parseInt(parts[0], 10);
    if (!Number.isInteger(g) || g <= 0) continue;
    const rest = parts.slice(1).join(",");
    const m = rest.match(/<@!?(\d+)>|@?(\d{15,21})/);
    const id = m ? (m[1] || m[2]) : null;
    if (!id) continue;
    if (!outMap.has(g)) outMap.set(g, new Set());
    outMap.get(g).add(id);
  }

  const groups = Array.from(outMap.keys()).sort((a, b) => a - b);
  const out = [];
  for (const g of groups) {
    const ids = Array.from(outMap.get(g));
    out.push(`${g}: ${ids.map(x => `<@${x}>`).join(" ")}`);
  }
  return out.join("\n");
}

/* =========================
 * 標題處理：允許以 ' | ' / '｜' / '│' / 字串 '\n' 換行
 * ========================= */
function normalizeTitleInput(s) {
  if (!s) return '';
  let t = String(s);
  t = t.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  t = t.replace(/[ \t]*(?:\||｜|│)[ \t]*/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

/* =========================
 * 業務模型：state 結構
 * ========================= */
/**
 * state = {
 *   title: string,
 *   caps: number[],
 *   members: { "1": string[], ... },
 *   multi: boolean,
 *   messageId: string|null,
 *   ownerId: string,
 *   token: string|null
 * }
 */
function buildInitialState({ title, caps, multi, defaults, messageId, ownerId, token }) {
  const groups = caps.length;
  const members = {};
  for (let i = 1; i <= groups; i++) members[String(i)] = [];
  if (defaults) {
    const lines = String(defaults).split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*(\d+)\s*:\s*(.*)$/);
      if (!m) continue;
      const idx = parseInt(m[1], 10);
      if (!members[String(idx)]) continue;
      const ids = Array.from(
        String(m[2]).matchAll(/<@!?(\d+)>|@?(\d{15,21})/g)
      ).map(x => x[1] || x[2]).filter(Boolean);
      for (const id of ids) {
        if (caps[idx - 1] > 0) { members[String(idx)].push(id); caps[idx - 1] -= 1; }
      }
    }
  }
  return {
    title: title || '',
    caps,
    members,
    multi: !!multi,
    messageId: messageId || null,
    ownerId: ownerId || '',
    token: token || null,
  };
}
async function saveStateById(messageId, state) {
  if (!messageId) return;
  await kvSet(`state:${messageId}`, state, 7 * 24 * 3600);
}
async function loadStateById(messageId) {
  if (!messageId) return null;
  return await kvGet(`state:${messageId}`);
}

/* =========================
 * 顯示名稱（暱稱）查詢與快取
 * ========================= */
async function fetchMemberDisplayName(guildId, userId) {
  const cacheKey = `name:${guildId}:${userId}`;
  const cached = await kvGet(cacheKey);
  if (cached) return cached;

  if (!BOT_TOKEN || !guildId) return String(userId);

  try {
    const url = `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`;
    const r = await fetch(url, {
      headers: { 'Authorization': `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
    if (!r.ok) return String(userId);
    const j = await r.json();
    const name =
      j.nick ||
      j.user?.global_name ||
      j.user?.username ||
      String(userId);
    await kvSet(cacheKey, name, 24 * 3600);
    return name;
  } catch {
    return String(userId);
  }
}
async function fetchManyDisplayNames(guildId, ids) {
  const uniq = Array.from(new Set(ids)).slice(0, 25);
  const names = await Promise.all(uniq.map(id => fetchMemberDisplayName(guildId, id)));
  const map = new Map();
  uniq.forEach((id, i) => map.set(id, names[i]));
  return map;
}

/* =========================
 * 文本與 UI
 * ========================= */
const hanMap = ['零','一','二','三','四','五','六','七','八','九','十','十一','十二','十三','十四','十五','十六'];
const numToHan = n => hanMap[n] ?? String(n);

// ★ 支援多行標題：第一行粗體，其餘逐行顯示
function buildMessageText(state) {
  const lines = [];
  if (state.title) {
    const parts = String(state.title).split('\n');
    if (parts.length) {
      lines.push(`**${parts[0]}**`);
      if (parts.length > 1) lines.push(...parts.slice(1));
    }
  }
  lines.push('\n目前名單：');
  const groups = state.caps.length;
  for (let i = 1; i <= groups; i++) {
    const arr = state.members[String(i)] || [];
    const mentions = arr.length ? arr.map(id => `<@${id}>`).join(' ') : '（無）';
    lines.push(`第${numToHan(i)}團（-${state.caps[i - 1]}）`);
    lines.push(mentions);
  }
  return lines.join('\n');
}

/**
 * ★ 新版按鈕：兩團同一行
 * - Discord 限制：最多 5 行、每行 5 個元件 → 25 元件
 * - 一團 2 個按鈕（加入/離開）→ 每行最多塞 2 團（4 個）
 * - 管理鍵佔 1 個，會被塞在最後一行（若滿則另起新行）
 * - 因此最多可同一則訊息容納 10 團 + 管理鍵
 */
function buildMainButtons(state) {
  const multiFlag = state.multi ? '1' : '0';
  const maxRows = 5;
  const maxPerRow = 5;
  const rows = [];
  let row = [];
  let groupsInRow = 0;

  const pushRow = () => {
    if (row.length) {
      rows.push({ type: 1, components: row });
      row = [];
      groupsInRow = 0;
    }
  };

  const totalGroups = Math.min(state.caps.length, 10); // 兩團/行 + 管理鍵 => 最多 10 團

  for (let i = 1; i <= totalGroups; i++) {
    if (row.length + 2 > maxPerRow || groupsInRow === 2) pushRow();

    row.push({ type: 2, style: 3, custom_id: `join_${i}__m${multiFlag}`, label: `加入第${numToHan(i)}團` });
    row.push({ type: 2, style: 2, custom_id: `leave_${i}`, label: `離開第${numToHan(i)}團` });
    groupsInRow += 1;
  }

  if (row.length + 1 > maxPerRow) pushRow();
  row.push({ type: 2, style: 1, custom_id: 'admin_open', label: '管理名單（踢人 / 移組）' });
  pushRow();

  return rows.slice(0, maxRows);
}

// ★ 這裡改為 async，會把 label 換成暱稱/顯示名稱
async function buildAdminPanelSelects(state, guildId) {
  const targetMid = state.messageId || '';
  const optionsKick = [];
  const optionsMovePick = [];
  const groups = state.caps.length;

  const allIds = [];
  for (let g = 1; g <= groups; g++) {
    const arr = state.members[String(g)] || [];
    for (const uid of arr) {
      allIds.push(uid);
      if (allIds.length >= 25) break;
    }
    if (allIds.length >= 25) break;
  }
  const nameMap = await fetchManyDisplayNames(guildId, allIds);

  outer:
  for (let g = 1; g <= groups; g++) {
    const arr = state.members[String(g)] || [];
    for (const uid of arr) {
      const disp = nameMap.get(uid) || uid;
      const left = state.caps[g - 1];
      const base = `第${numToHan(g)}團${left != null ? `（剩 ${left}）` : ''} - ${disp}`;
      optionsKick.push({ label: `踢出 ${base}`, value: `kick:${g}:${uid}` });
      optionsMovePick.push({ label: `移組（選人） ${base}`, value: `pick:${g}:${uid}` });
      if (optionsKick.length >= 25 || optionsMovePick.length >= 25) break outer;
    }
  }

  const components = [];
  if (optionsKick.length) {
    components.push({
      type: 1,
      components: [{
        type: 3,
        custom_id: `admin_manage:kick:${targetMid}`,
        placeholder: '選擇要踢出的成員',
        min_values: 1, max_values: 1, options: optionsKick,
      }],
    });
  }
  if (optionsMovePick.length) {
    components.push({
      type: 1,
      components: [{
        type: 3,
        custom_id: `admin_manage:pickmove:${targetMid}`,
        placeholder: '選擇要移組的成員（下一步選目的團）',
        min_values: 1, max_values: 1, options: optionsMovePick,
      }],
    });
  }
  if (!components.length) {
    components.push({
      type: 1,
      components: [{ type: 2, style: 2, custom_id: 'noop', label: '目前沒有可管理的成員', disabled: true }],
    });
  }
  return components;
}

function buildMoveToSelect(state, userId, fromIdx) {
  const targetMid = state.messageId || '';
  const options = [];
  const groups = state.caps.length;
  for (let g = 1; g <= groups; g++) {
    if (g === fromIdx) continue;
    options.push({
      label: `移至 第${numToHan(g)}團（剩 ${state.caps[g-1]}）`,
      value: String(g),
    });
  }
  return [{
    type: 1,
    components: [{
      type: 3,
      custom_id: `admin_manage:to:${userId}:${fromIdx}:${targetMid}`,
      placeholder: '選擇目的團',
      min_values: 1, max_values: 1,
      options: options.length ? options : [{ label: '沒有可移動的團', value: '0', default: true }],
    }],
  }];
}

/* =========================
 * 權限
 * ========================= */
function hasAdmin(interaction, state) {
  const uid = interaction.member?.user?.id || interaction.user?.id;
  if (uid && state?.ownerId && uid === state.ownerId) return true;
  const p = interaction.member?.permissions;
  if (!p) return false;
  try {
    const perms = BigInt(p);
    const ADMINISTRATOR = 1n << 3n;
    const MANAGE_GUILD = 1n << 5n;
    const MANAGE_MESSAGES = 1n << 13n;
    if ((perms & ADMINISTRATOR) !== 0n) return true;
    if ((perms & MANAGE_GUILD) !== 0n) return true;
    if ((perms & MANAGE_MESSAGES) !== 0n) return true;
  } catch {}
  return false;
}

/* =========================
 * 互動處理
 * ========================= */
export default async function handler(req, res) {
  // ===== 健康檢查 / 探測（不驗簽，直接 200，避免被自動移除）=====
  if (req.method === 'HEAD' || req.method === 'GET' || req.method === 'OPTIONS') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // 基本 CORS（OPTIONS 預檢時也能通過）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    return res.status(200).end();
  }

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // ===== 互動請求（POST）：必須帶簽章 =====
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  if (!signature || !timestamp) {
    return res.status(401).send('missing signature');
  }
  const rawBody = await readRawBody(req);

  if (VERIFY_SIGNATURE) {
    try {
      const ok = verifyKey(rawBody, signature, timestamp, PUBLIC_KEY);
      if (!ok) return res.status(401).send('invalid request signature');
    } catch { return res.status(401).send('invalid request signature'); }
  }

  const interaction = JSON.parse(rawBody);

  // PING
  if (interaction.type === InteractionType.PING) {
    return res.status(200).json({ type: InteractionResponseType.PONG });
  }

  // /cteam：同步回覆
  if (interaction.type === InteractionType.APPLICATION_COMMAND &&
      interaction.data?.name === 'cteam') {

    const opts = interaction.data.options || [];
    const caps = parseCaps(opts);
    const multi = !!getOpt(opts, 'multi');
    const title = normalizeTitleInput(getOpt(opts, 'title') || '');
    let defaults = getOpt(opts, 'defaults') || '';
    const ownerId = interaction.member?.user?.id || interaction.user?.id || '';

    const defAtt = getAttachment(interaction, 'defaults_file');
    if (defAtt) {
      const txt = await readAttachmentText(defAtt);
      if (txt != null) {
        const name = (defAtt.filename || '').toLowerCase();
        const looksCsv = name.endsWith('.csv') || /,/.test((txt.split(/\r?\n/)[0] || ''));
        if (looksCsv) {
          const converted = csvToDefaults(txt);
          if (converted) defaults = converted;
        } else {
          defaults = String(txt).replace(/\r\n/g, '\n').trim();
        }
      }
    }

    const initState = buildInitialState({
      title, caps, multi, defaults,
      messageId: null,
      ownerId,
      token: interaction.token,
    });
    await kvSet(`boot:${interaction.token}`, initState, 3600);

    return res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: buildMessageText(initState),
        components: buildMainButtons(initState),
        allowed_mentions: { parse: [] },
      },
    });
  }

  // MESSAGE_COMPONENT
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = interaction.data?.custom_id || '';
    aconst userId = interaction.member?.user?.id || interaction.user?.id;
    const message = interaction.message;
    const messageId = message?.id;
    const channelId = message?.channel_id;

    const msgIdFromCid = customId.startsWith('admin_manage:')
      ? customId.split(':').slice(-1)[0]
      : null;
    const targetMessageId = msgIdFromCid || messageId;

    let baseState =
        await loadStateById(targetMessageId)
     || await kvGet(`boot:${interaction.token}`)
     || fallbackStateFromContent(message?.content || '');
    baseState.messageId = targetMessageId;

    // === 管理面板：開啟 & 選人（直接 type:4 回 ephemeral）===
    if (customId === 'admin_open') {
      if (!hasAdmin(interaction, baseState)) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '只有開團者或伺服器管理員可以使用管理功能。', flags: 64 }
        });
      }
      baseState.messageId = targetMessageId;

      const comps = await buildAdminPanelSelects(baseState, interaction.guild_id);

      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: '管理名單（踢人 / 移組）',
          components: comps,
          flags: 64,
          allowed_mentions: { parse: [] },
        }
      });
    }

    if (customId.startsWith('admin_manage:pickmove')) {
      if (!hasAdmin(interaction, baseState)) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '只有開團者或伺服器管理員可以使用管理功能。', flags: 64 }
        });
      }
      const v = interaction.data.values?.[0] || '';
      const m = v.match(/^pick:(\d+):(\d+)$/);
      if (!m) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '無效的選項。', flags: 64 }
        });
      }
      const fromIdx = parseInt(m[1], 10);
      const moveId  = m[2];

      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `選擇 <@${moveId}> 的目的團：`,
          components: buildMoveToSelect(baseState, moveId, fromIdx),
          flags: 64,
          allowed_mentions: { parse: [] },
        }
      });
    }

    // === 管理面板：真正執行（同步處理，直接回 ephemeral 成功訊息）===
    if (customId.startsWith('admin_manage:kick:') || customId.startsWith('admin_manage:to:')) {
      if (!hasAdmin(interaction, baseState)) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '只有開團者或伺服器管理員可以使用管理功能。', flags: 64 }
        });
      }

      try {
        await withLock(`msg:${targetMessageId}`, 5, async () => {
          if (customId.startsWith('admin_manage:kick:')) {
            const v = interaction.data.values?.[0] || '';
            const m = v.match(/^kick:(\d+):(\d+)$/);
            if (!m) throw new Error('無效的選項');
            const g = parseInt(m[1], 10);
            const kickId = m[2];

            const arr = baseState.members[String(g)] || [];
            const pos = arr.indexOf(kickId);
            if (pos === -1) throw new Error('成員不在該團。');
            arr.splice(pos, 1);
            baseState.caps[g - 1] += 1;

            await saveStateById(targetMessageId, baseState);
            await patchOriginal(interaction, baseState, channelId);
            return res.status(200).json({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: { content: `已將 <@${kickId}> 踢出第${numToHan(g)}團。`, flags: 64, allowed_mentions: { parse: [] } }
            });
          }

          const seg = customId.split(':');
          const moveId = seg[2];
          const fromIdx = parseInt(seg[3], 10);
          const toIdx = parseInt(interaction.data.values?.[0] || '0', 10);
          if (!toIdx || toIdx === fromIdx) throw new Error('無效的目的團。');
          if (baseState.caps[toIdx - 1] <= 0) throw new Error(`第${numToHan(toIdx)}團名額已滿。`);

          const fromArr = baseState.members[String(fromIdx)] || [];
          const pos = fromArr.indexOf(moveId);
          if (pos === -1) throw new Error('該成員已不在原團。');

          fromArr.splice(pos, 1);
          baseState.caps[fromIdx - 1] += 1;
          const toArr = baseState.members[String(toIdx)] || [];
          if (!toArr.includes(moveId)) { toArr.push(moveId); baseState.caps[toIdx - 1] -= 1; }

          await saveStateById(targetMessageId, baseState);
          await patchOriginal(interaction, baseState, channelId);
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: `已將 <@${moveId}> 從第${numToHan(fromIdx)}團移至第${numToHan(toIdx)}團。`, flags: 64, allowed_mentions: { parse: [] } }
          });
        });
      } catch (e) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `處理失敗：${String(e?.message || '未知錯誤')}`, flags: 64 }
        });
      }
      return;
    }

    // === 快速路徑：join/leave 嘗試在同次請求內完成並 UPDATE_MESSAGE ===
    if (FAST_UPDATE) {
      try {
        const quick = await Promise.race([
          (async () => {
            let state = { ...baseState };

            const jm = customId.match(/^(join|leave)_(\d+)(?:__m([01]))?$/);
            if (!jm) return null;

            const action = jm[1];
            const idx = parseInt(jm[2], 10);
            if (jm[3] === '0' || jm[3] === '1') state.multi = jm[3] === '1';

            await withLock(`msg:${targetMessageId}`, LOCK_TTL_SEC, async () => {
              const myGroups = Object.entries(state.members)
                .filter(([, arr]) => Array.isArray(arr) && arr.includes(userId))
                .map(([k]) => parseInt(k, 10));

              if (action === 'join') {
                if (!state.multi && myGroups.length > 0 && !myGroups.includes(idx)) {
                  throw new Error('EPH:你已加入其他團，未開啟「允許多團」。');
                }
                if (state.caps[idx - 1] <= 0) {
                  throw new Error(`EPH:第${numToHan(idx)}團名額已滿。`);
                }
                const arr = state.members[String(idx)];
                if (!arr.includes(userId)) {
                  arr.push(userId);
                  state.caps[idx - 1] -= 1;
                } else {
                  throw new Error(`EPH:你已在第${numToHan(idx)}團。`);
                }
              } else {
                const arr = state.members[String(idx)];
                const pos = arr.indexOf(userId);
                if (pos === -1) throw new Error(`EPH:你不在第${numToHan(idx)}團。`);
                arr.splice(pos, 1);
                state.caps[idx - 1] += 1;
              }

              if (!state.token) state.token = baseState.token || null;
              await saveStateById(targetMessageId, state);
              baseState = state;
            });

            return {
              kind: 'update',
              data: {
                content: buildMessageText(baseState),
                components: buildMainButtons(baseState),
                allowed_mentions: { parse: [] },
              }
            };
          })(),
          sleep(FAST_TIMEOUT_MS).then(() => null),
        ]);

        if (quick?.kind === 'update') {
          return res.status(200).json({
            type: InteractionResponseType.UPDATE_MESSAGE,
            data: quick.data,
          });
        }
      } catch (e) {
        const msg = String(e?.message || '');
        if (msg.startsWith('EPH:')) {
          return res.status(200).json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: msg.slice(4), flags: 64, allowed_mentions: { parse: [] } }
          });
        }
      }
    }

    // === 保險路徑（join/leave）===
    res.status(200).json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });

    (async () => {
      try {
        let state =
            await loadStateById(targetMessageId)
         || await kvGet(`boot:${interaction.token}`)
         || fallbackStateFromContent(message?.content || '');
        state.messageId = targetMessageId;

        const m = customId.match(/^(join|leave)_(\d+)(?:__m([01]))?$/);
        if (!m) return;

        const action = m[1];
        const idx = parseInt(m[2], 10);
        if (m[3] === '0' || m[3] === '1') state.multi = m[3] === '1';

        await withLock(`msg:${targetMessageId}`, 4, async () => {
          const myGroups = Object.entries(state.members)
            .filter(([, arr]) => Array.isArray(arr) && arr.includes(userId))
            .map(([k]) => parseInt(k, 10));

          if (action === 'join') {
            if (!state.multi && myGroups.length > 0 && !myGroups.includes(idx)) {
              await followupEphemeral(interaction, '你已加入其他團，未開啟「允許多團」。'); return;
            }
            if (state.caps[idx - 1] <= 0) {
              await followupEphemeral(interaction, `第${numToHan(idx)}團名額已滿。`); return;
            }
            const arr = state.members[String(idx)];
            if (!arr.includes(userId)) { arr.push(userId); state.caps[idx - 1] -= 1; }
            else { await followupEphemeral(interaction, `你已在第${numToHan(idx)}團。`); return; }
          } else {
            const arr = state.members[String(idx)];
            const pos = arr.indexOf(userId);
            if (pos === -1) { await followupEphemeral(interaction, `你不在第${numToHan(idx)}團。`); return; }
            arr.splice(pos, 1);
            state.caps[idx - 1] += 1;
          }

          await saveStateById(targetMessageId, state);
          await patchOriginal(interaction, state, channelId);
        });
      } catch (e) {
        console.error('component error', e);
        await followupEphemeral(interaction, '處理時發生錯誤，請再試一次。');
      }
    })();

    return;
  }

  // 其他互動
  return res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: '未處理的互動類型。', flags: 64 },
  });
}

/* =========================
 * PATCH 原訊息（共用，含 Bot Token 後援）
 * ========================= */
async function patchOriginal(interaction, state, channelId) {
  const newContent = buildMessageText(state);
  const newComponents = buildMainButtons(state);

  // 先嘗試 webhook token（最理想）
  if (state.token) {
    const url = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${state.token}/messages/${state.messageId}`;
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: newContent,
        components: newComponents,
        allowed_mentions: { parse: [] },
      }),
    });
    if (r.ok) return;
    console.warn('webhook patch failed', r.status, await r.text());
  }

  // 後援：用 Bot Token 改頻道訊息（只要是自己機器人發的就能改）
  if (BOT_TOKEN && channelId) {
    const url2 = `https://discord.com/api/v10/channels/${channelId}/messages/${state.messageId}`;
    const r2 = await fetch(url2, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bot ${BOT_TOKEN}`,
      },
      body: JSON.stringify({
        content: newContent,
        components: newComponents,
        allowed_mentions: { parse: [] },
      }),
    });
    if (r2.ok) return;
    console.error('bot patch failed', r2.status, await r2.text());
  } else {
    console.error('bot patch skipped: missing BOT_TOKEN or channelId');
  }

  await followupEphemeral(interaction, '系統忙碌，請稍後再試（已收到你的操作）。');
}

/* =========================
 * 輔助：ephemeral follow-up / post
 * ========================= */
async function followupEphemeral(interaction, text) {
  try {
    await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, flags: 64, allowed_mentions: { parse: [] } }),
    });
  } catch (_) {}
}

/* =========================
 * /cteam 參數
 * ========================= */
function getOpt(opts, name) { return opts?.find(o => o.name === name)?.value; }
function parseCaps(opts) {
  const raw = getOpt(opts, 'caps');
  if (!raw) return [12,12,12];
  const arr = String(raw).split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n >= 0);
  return arr.length ? arr : [12,12,12];
}

/* =========================
 * 從訊息內容 fallback（含標題還原）
 * ========================= */
function parseTitleFromContent(content) {
  const lines = String(content || '').split('\n');
  const idx = lines.findIndex(l => l.trim() === '目前名單：');
  if (idx <= 0) return '';
  const header = lines.slice(0, idx)
    .map(s => s.trim())
    .filter(Boolean);
  if (!header.length) return '';
  header[0] = header[0].replace(/^\*\*(.+?)\*\*$/, '$1').trim();
  return header.join('\n');
}
function fallbackStateFromContent(content) {
  const lines = String(content || '').split('\n');

  const title = parseTitleFromContent(content);

  const start = Math.max(0, lines.findIndex(l => l.trim() === '目前名單：') + 1);

  const caps = [];
  const members = {};
  let groupIdx = 0;
  for (let i = start; i < lines.length; i++) {
    const s = lines[i].trim();
    const m = s.match(/^第(.+?)團（-(\d+)）$/);
    if (m) {
      groupIdx += 1;
      caps.push(parseInt(m[2], 10));
      const next = (lines[i+1] || '').trim();
      const ids = Array.from(next.matchAll(/<@!?(\d+)>/g)).map(x => x[1]);
      members[String(groupIdx)] = ids;
    }
  }
  if (caps.length === 0) {
    caps.push(12,12,12);
    members["1"] = []; members["2"] = []; members["3"] = [];
  }
  return { title, caps, members, multi: false, messageId: null, ownerId: '', token: null };
}

// 確保能讀到 raw body（Next.js API Route）
export const config = {
  api: { bodyParser: false },
};
