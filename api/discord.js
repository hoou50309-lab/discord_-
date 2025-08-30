// api/discord.js
// 穩定版 + 管理選單（踢人 / 移組）+ 修正重複貼訊息 + 原始 token 綁定（修正從 ephemeral 觸發時無法更新原文）
// - /cteam 同步回覆（type:4）；若需要讀取 defaults 附件，改走 deferred（type:5）再 PATCH @original
// - join/leave：快速路徑 2.2s 內直接 UPDATE_MESSAGE（type:7），否則走 defer+PATCH
// - admin_open / admin_manage:pickmove 直接回覆 ephemeral（type:4, flags:64）避免重複
// - 狀態優先 Redis（UPSTASH_REDIS_REST_URL/TOKEN），無則記憶體
// - VERIFY_SIGNATURE 預設依環境：Production=true、其餘=false（可被環境變數覆寫）
// - /cteam defaults 可讀取「預設人員名單」附件（Attachment），若有附件則覆蓋文字值

import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from 'discord-interactions';

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
 * /cteam 預設名單附件：讀取工具
 * ========================= */
const DEFAULTS_FILE_HINT = '預設人員名單';

// 只判斷是否帶到附件（不抓取），用來決定是否先回 defer
function hasDefaultsAttachment(interaction, optionName = 'defaults') {
  try {
    const opts = interaction.data?.options || [];
    const resolvedAtt = interaction.data?.resolved?.attachments || {};
    if (!resolvedAtt || Object.keys(resolvedAtt).length === 0) return false;
    const opt = opts.find(o => o.name === optionName);
    if (opt && resolvedAtt[opt.value]) return true; // 明確用 Attachment option
    for (const k in resolvedAtt) {
      const a = resolvedAtt[k];
      const fname = String(a?.filename || a?.name || '');
      if (fname.includes(DEFAULTS_FILE_HINT)) return true;
    }
    return false;
  } catch { return false; }
}

// 讀取 /cteam 的附件（option: defaults 或檔名含「預設人員名單」），回傳文字，失敗回 null
async function loadDefaultsFromAttachment(interaction, optionName = 'defaults') {
  try {
    const opts = interaction.data?.options || [];
    const resolvedAtt = interaction.data?.resolved?.attachments || {};

    const opt = opts.find(o => o.name === optionName);
    let att = (opt && resolvedAtt[opt.value]) ? resolvedAtt[opt.value] : null;

    if (!att) {
      for (const k in resolvedAtt) {
        const a = resolvedAtt[k];
        const fname = String(a?.filename || a?.name || '');
        if (fname.includes(DEFAULTS_FILE_HINT)) { att = a; break; }
      }
    }
    if (!att) return null;

    if (att.size && att.size > 2 * 1024 * 1024) {
      console.warn('defaults attachment too large:', att.size);
      return null;
    }

    const url = att.url || att.proxy_url;
    if (!url) return null;

    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) {
      console.warn('fetch defaults attachment failed', r.status, await r.text());
      return null;
    }
    return await r.text();
  } catch (e) {
    console.error('loadDefaultsFromAttachment error', e);
    return null;
  }
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
      const ids = Array.from(m[2].matchAll(/<@!?(\d+)>/g)).map(x => x[1]);
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
 * 文本與 UI
 * ========================= */
const hanMap = ['零','一','二','三','四','五','六','七','八','九','十','十一','十二','十三','十四','十五','十六'];
const numToHan = n => hanMap[n] ?? String(n);

function buildMessageText(state) {
  const lines = [];
  if (state.title) lines.push(`**${state.title}**`);
  lines.push('目前名單：');
  const groups = state.caps.length;
  for (let i = 1; i <= groups; i++) {
    const arr = state.members[String(i)] || [];
    const mentions = arr.length ? arr.map(id => `<@${id}>`).join(' ') : '（無）';
    lines.push(`第${numToHan(i)}團（-${state.caps[i - 1]}）`);
    lines.push(mentions);
  }
  return lines.join('\n');
}

/** 把 /cteam 的 token 夾在 join/leave custom_id，之後互動可用 boot:<token> 取回初始 state */
function buildMainButtons(state) {
  const groupCount = state.caps.length;
  const tag = state.token ? `:${state.token}` : '';
  const rows = [];
  for (let i = 1; i <= groupCount; i++) {
    rows.push({
      type: 1,
      components: [
        { type: 2, style: 3, custom_id: `join_${i}${tag}`,  label: `加入第${numToHan(i)}團` },
        { type: 2, style: 2, custom_id: `leave_${i}${tag}`, label: `離開第${numToHan(i)}團` },
      ],
    });
  }
  rows.push({
    type: 1,
    components: [{ type: 2, style: 1, custom_id: 'admin_open', label: '管理名單（踢人 / 移組）' }],
  });
  return rows;
}

/* === 管理面板 custom_id 夾帶原文 messageId === */
function buildAdminPanelSelects(state) {
  const targetMid = state.messageId || '';
  const optionsKick = [];
  const optionsMovePick = [];
  const groups = state.caps.length;
  outer:
  for (let g = 1; g <= groups; g++) {
    const arr = state.members[String(g)] || [];
    for (const uid of arr) {
      const label = `第${numToHan(g)}團 - ${uid}`;
      optionsKick.push({ label: `踢出 ${label}`, value: `kick:${g}:${uid}` });
      optionsMovePick.push({ label: `移組（選人） ${label}`, value: `pick:${g}:${uid}` });
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

/* === 第二步目的團 custom_id 也帶 messageId === */
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
  if (req.method === 'HEAD') {
    if (VERIFY_SIGNATURE) {
      const signature = req.headers['x-signature-ed25519'];
      const timestamp = req.headers['x-signature-timestamp'];
      if (!signature || !timestamp) {
        return res.status(401).send('missing signature');
      }
      try {
        const ok = verifyKey('', signature, timestamp, PUBLIC_KEY);
        if (!ok) return res.status(401).send('invalid request signature');
      } catch {
        return res.status(401).send('invalid request signature');
      }
    }
    return res.status(200).end();
  }

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
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

  // /cteam：同步回覆（有附件則先 defer 再補上）
  if (interaction.type === InteractionType.APPLICATION_COMMAND &&
      interaction.data?.name === 'cteam') {

    const opts = interaction.data.options || [];
    const caps = parseCaps(opts);
    const multi = !!getOpt(opts, 'multi');
    const title = getOpt(opts, 'title') || '';

    const attachmentIncoming = hasDefaultsAttachment(interaction, 'defaults');

    // 有附件 → 立即 defer，等待抓附件完成再 PATCH @original
    if (attachmentIncoming) {
      res.status(200).json({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      });

      (async () => {
        let defaults = getOpt(opts, 'defaults') || '';
        const attachTxt = await loadDefaultsFromAttachment(interaction, 'defaults');
        if (attachTxt) defaults = attachTxt;

        const ownerId = interaction.member?.user?.id || interaction.user?.id || '';

        const initState = buildInitialState({
          title, caps, multi, defaults,
          messageId: null,
          ownerId,
          token: interaction.token,
        });

        await kvSet(`boot:${interaction.token}`, initState, 3600);
        await patchOriginalFromDeferred(interaction, initState); // 會回寫 messageId 並存 state
      })();

      return; // 已回 defer
    }

    // 沒有附件 → 走原本同步回覆（type:4）
    let defaults = getOpt(opts, 'defaults') || '';
    // 就算沒有附件，這個函式很快（會回 null）
    const attachTxt = await loadDefaultsFromAttachment(interaction, 'defaults');
    if (attachTxt) defaults = attachTxt;

    const ownerId = interaction.member?.user?.id || interaction.user?.id || '';

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
    const userId = interaction.member?.user?.id || interaction.user?.id;
    const message = interaction.message;
    const messageId = message?.id;

    // admin 面板的 custom_id 最後一段是原文 messageId
    const msgIdFromCid = customId.startsWith('admin_manage:')
      ? customId.split(':').slice(-1)[0]
      : null;
    const targetMessageId = msgIdFromCid || messageId;

    // join/leave 的 custom_id 最後一段夾的是 /cteam 的 token
    const joinLeaveBootToken =
      (customId.startsWith('join_') || customId.startsWith('leave_'))
        ? (customId.split(':').slice(1).join(':') || null)
        : null;

    // 先準備 state（優先用 boot:<token> 讀到 /cteam 初始狀態，確保 multi 等旗標正確）
    let baseState =
        await loadStateById(targetMessageId)
     || (joinLeaveBootToken ? await kvGet(`boot:${joinLeaveBootToken}`) : null)
     || await kvGet(`boot:${interaction.token}`)
     || fallbackStateFromContent(message?.content || '');
    baseState.messageId = targetMessageId;
    if (!baseState.token) baseState.token = joinLeaveBootToken || interaction.token;

    // 直接回 ephemeral（避免重複）
    if (customId === 'admin_open') {
      if (!hasAdmin(interaction, baseState)) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '只有開團者或伺服器管理員可以使用管理功能。', flags: 64 }
        });
      }
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: '管理名單（踢人 / 移組）',
          components: buildAdminPanelSelects(baseState),
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

    // 快速路徑：join/leave
    if (FAST_UPDATE) {
      try {
        const quick = await Promise.race([
          (async () => {
            let state = { ...baseState };

            const head = customId.split(':')[0];
            const jm = head.match(/^(join|leave)_(\d+)$/);
            if (!jm) return null;

            const action = jm[1];
            const idx = parseInt(jm[2], 10);

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

    // 保險路徑
    res.status(200).json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });

    (async () => {
      try {
        let state =
            await loadStateById(targetMessageId)
         || (joinLeaveBootToken ? await kvGet(`boot:${joinLeaveBootToken}`) : null)
         || await kvGet(`boot:${interaction.token}`)
         || fallbackStateFromContent(message?.content || '');
        state.messageId = targetMessageId;
        if (!state.token) state.token = joinLeaveBootToken || interaction.token;

        const cid = customId;

        if (cid.startsWith('admin_manage:')) {
          if (!hasAdmin(interaction, state)) {
            await followupEphemeral(interaction, '只有開團者或伺服器管理員可以使用管理功能。');
            return;
          }

          await withLock(`msg:${targetMessageId}`, 5, async () => {
            if (cid.startsWith('admin_manage:kick:')) {
              const v = interaction.data.values?.[0] || '';
              const m = v.match(/^kick:(\d+):(\d+)$/);
              if (!m) return;
              const g = parseInt(m[1], 10);
              const kickId = m[2];
              const arr = state.members[String(g)] || [];
              const pos = arr.indexOf(kickId);
              if (pos === -1) { await followupEphemeral(interaction, '成員不在該團。'); return; }
              arr.splice(pos, 1);
              state.caps[g - 1] += 1;

              await saveStateById(targetMessageId, state);
              await patchOriginal(interaction, state);
              await followupEphemeral(interaction, `已將 <@${kickId}> 踢出第${numToHan(g)}團。`);
              return;
            }

            if (cid.startsWith('admin_manage:to:')) {
              const seg = cid.split(':'); // admin_manage:to:{uid}:{from}:{msgId}
              const moveId = seg[2];
              const fromIdx = parseInt(seg[3], 10);
              const toIdx = parseInt(interaction.data.values?.[0] || '0', 10);
              if (!toIdx || toIdx === fromIdx) { await followupEphemeral(interaction, '無效的目的團。'); return; }
              if (state.caps[toIdx - 1] <= 0) { await followupEphemeral(interaction, `第${numToHan(toIdx)}團名額已滿。`); return; }

              const fromArr = state.members[String(fromIdx)] || [];
              const pos = fromArr.indexOf(moveId);
              if (pos === -1) { await followupEphemeral(interaction, '該成員已不在原團。'); return; }

              fromArr.splice(pos, 1);
              state.caps[fromIdx - 1] += 1;
              const toArr = state.members[String(toIdx)] || [];
              if (!toArr.includes(moveId)) { toArr.push(moveId); state.caps[toIdx - 1] -= 1; }

              await saveStateById(targetMessageId, state);
              await patchOriginal(interaction, state);
              await followupEphemeral(interaction, `已將 <@${moveId}> 從第${numToHan(fromIdx)}團移至第${numToHan(toIdx)}團。`);
              return;
            }
          });
          return;
        }

        const head = cid.split(':')[0];
        const m = head.match(/^(join|leave)_(\d+)$/);
        if (m) {
          const action = m[1];
          const idx = parseInt(m[2], 10);

          await withLock(`msg:${targetMessageId}`, 4, async () => {
            const myGroups = Object.entries(state.members)
              .filter(([, arr]) => Array.isArray(arr) && arr.includes(userId))
              .map(([k]) => parseInt(k, 10));

            if (action === 'join') {
              if (!state.multi && myGroups.length > 0 && !myGroups.includes(idx)) {
                await followupEphemeral(interaction, '你已加入其他團，未開啟「允許多團」。');
                return;
              }
              if (state.caps[idx - 1] <= 0) {
                await followupEphemeral(interaction, `第${numToHan(idx)}團名額已滿。`);
                return;
              }
              const arr = state.members[String(idx)];
              if (!arr.includes(userId)) {
                arr.push(userId);
                state.caps[idx - 1] -= 1;
              } else {
                await followupEphemeral(interaction, `你已在第${numToHan(idx)}團。`);
                return;
              }
            } else {
              const arr = state.members[String(idx)];
              const pos = arr.indexOf(userId);
              if (pos === -1) {
                await followupEphemeral(interaction, `你不在第${numToHan(idx)}團。`);
                return;
              }
              arr.splice(pos, 1);
              state.caps[idx - 1] += 1;
            }

            await saveStateById(targetMessageId, state);
            await patchOriginal(interaction, state);
          });

          return;
        }

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
 * PATCH 原訊息（共用）
 * ========================= */
async function patchOriginal(interaction, state) {
  const newContent = buildMessageText(state);
  const newComponents = buildMainButtons(state);

  const token = state.token || interaction.token;
  const msgId = state.messageId;
  const url = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${token}/messages/${msgId}`;

  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: newContent,
      components: newComponents,
      allowed_mentions: { parse: [] },
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    console.error('patch failed', r.status, text);
    await followupEphemeral(interaction, '系統忙碌，請稍後再試（已收到你的操作）。');
  }
}

/* === /cteam defer 後：PATCH @original，並回存 messageId === */
async function patchOriginalFromDeferred(interaction, state) {
  const url = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  try {
    const r = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: buildMessageText(state),
        components: buildMainButtons(state),
        allowed_mentions: { parse: [] },
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error('patch @original failed', r.status, t);
      await followupEphemeral(interaction, '建立名單失敗，請再試一次。');
      return;
    }
    // 取得訊息 id，之後互動就能用 messageId 直接載入 state
    const msg = await r.json().catch(() => null);
    const mid = msg?.id;
    if (mid) {
      state.messageId = mid;
      await saveStateById(mid, state);
    }
  } catch (e) {
    console.error('patchOriginalFromDeferred error', e);
    await followupEphemeral(interaction, '建立名單失敗，請再試一次。');
  }
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
 * 從訊息內容 fallback
 * ========================= */
function fallbackStateFromContent(content) {
  const lines = String(content || '').split('\n');
  const caps = [];
  const members = {};
  let groupIdx = 0;
  for (let i = 0; i < lines.length; i++) {
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
  return { title: '', caps, members, multi: false, messageId: null, ownerId: '', token: null };
}

// 確保能讀到 raw body（Next.js API Route）
export const config = {
  api: { bodyParser: false },
};
