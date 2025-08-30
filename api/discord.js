// api/discord.js
export const config = { runtime: 'nodejs' };

import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from 'discord-interactions';

// ============ Env & switches ============
const PUBLIC_KEY  = process.env.PUBLIC_KEY;
const VERIFY_ONLY = String(process.env.VERIFY_ONLY ?? 'false').toLowerCase() === 'true'; // 預設關閉
const RURL        = process.env.UPSTASH_REDIS_REST_URL || '';
const RTOK        = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const HAVE_REDIS  = !!(RURL && RTOK);

// ============ Utils ============
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// Discord API with retry/backoff
async function discordFetch(url, init, maxRetry = 5) {
  for (let i = 0; i < maxRetry; i++) {
    const r = await fetch(url, init);
    if (r.status === 429) {
      const wait = Number(r.headers.get('x-ratelimit-reset-after')) || 0.7;
      await sleep(wait * 1000 + Math.random() * 200);
      continue;
    }
    if (r.status >= 500) {
      await sleep(250 + i * 150);
      continue;
    }
    return r;
  }
  throw new Error('discordFetch-retry-exhausted');
}

// Upstash Redis
async function redis(cmd, ...args) {
  if (!HAVE_REDIS) return null;
  const url = `${RURL}/${cmd}/${args.map(encodeURIComponent).join('/')}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${RTOK}` } });
  const j = await r.json().catch(() => ({}));
  return j;
}

// 分散式鎖（Upstash）/ 本地退化
const localLocks = new Map();
async function withLock(key, ttlMs, fn) {
  if (HAVE_REDIS) {
    const token = crypto.randomUUID();
    for (let i = 0; i < 6; i++) {
      const set = await redis('SET', key, token, 'NX', 'PX', ttlMs);
      if (set?.result === 'OK') {
        try {
          return await fn();
        } finally {
          const cur = await redis('GET', key);
          if (cur?.result === token) await redis('DEL', key);
        }
      }
      await sleep(50 + Math.random() * 150);
    }
    throw new Error('lock-timeout');
  } else {
    if (localLocks.has(key)) {
      for (let i = 0; i < 8 && localLocks.has(key); i++) {
        await sleep(60 + Math.random() * 120);
      }
      if (localLocks.has(key)) throw new Error('lock-timeout');
    }
    localLocks.set(key, 1);
    try {
      return await fn();
    } finally {
      localLocks.delete(key);
    }
  }
}

// Ephemeral admin context（存「目前選取的成員」）
const localEphemeral = new Map();
function gcLocalEphemeral() {
  const now = Date.now();
  for (const [k, v] of localEphemeral) if (v.exp < now) localEphemeral.delete(k);
}
async function setEphemeral(key, val, ttlMs = 120000) {
  if (HAVE_REDIS) {
    await redis('SET', `admctx:${key}`, JSON.stringify(val), 'PX', ttlMs);
  } else {
    gcLocalEphemeral();
    localEphemeral.set(key, { exp: Date.now() + ttlMs, val });
  }
}
async function getEphemeral(key) {
  if (HAVE_REDIS) {
    const j = await redis('GET', `admctx:${key}`);
    if (j?.result) try { return JSON.parse(j.result); } catch {}
    return null;
  } else {
    gcLocalEphemeral();
    const hit = localEphemeral.get(key);
    if (!hit) return null;
    if (hit.exp < Date.now()) { localEphemeral.delete(key); return null; }
    return hit.val;
  }
}

// ============ State helpers ============
function emptyState(maxCaps = [5, 5, 5], title = '', multi = false, ownerId = '') {
  const members = {};
  for (let i = 1; i <= maxCaps.length; i++) members[String(i)] = [];
  return { version: 1, title, max: maxCaps, members, multi, ownerId };
}

function parseDefaults(defaultsStr = '') {
  const obj = {};
  const lines = String(defaultsStr || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^(\d+)\s*:\s*(.+)$/);
    if (!m) continue;
    const idx = String(parseInt(m[1], 10));
    const ids = Array.from(m[2].matchAll(/<@!?(\d+)>/g)).map(x => x[1]);
    obj[idx] = ids;
  }
  return obj;
}

function buildContentFromState(state) {
  const han = ['零','一','二','三','四','五','六','七','八','九','十','十一','十二','十三','十四','十五','十六','十七','十八','十九','二十'];
  const numToHan = (n) => han[n] ?? String(n);

  const lines = [];
  if (state.title) {
    lines.push(state.title);
    lines.push('');
  }
  for (let i = 0; i < state.max.length; i++) {
    const groupNo = i + 1;
    const remain = Math.max(0, state.max[i] - (state.members[String(groupNo)]?.length || 0));
    lines.push(`第${numToHan(groupNo)}團（-${remain}）`);
    lines.push('');
  }
  const hidden = `<!-- state: ${JSON.stringify(state)} -->`;
  return lines.join('\n') + '\n' + hidden;
}

function buildComponents(state) {
  const rows = [];
  for (let i = 0; i < state.max.length; i++) {
    const groupNo = i + 1;
    rows.push({
      type: 1,
      components: [
        { type: 2, style: 3, custom_id: `join_${groupNo}`,  label: `加入第${groupNo}團` },
        { type: 2, style: 2, custom_id: `leave_${groupNo}`, label: `離開第${groupNo}團` },
      ],
    });
  }
  // 工具列：查看所有名單 + 管理名單
  rows.push({
    type: 1,
    components: [
      { type: 2, style: 1, custom_id: 'view_all',   label: '查看所有名單' },
      { type: 2, style: 1, custom_id: 'admin_manage', label: '管理名單' },
    ],
  });
  return rows;
}

function extractStateFromContent(content) {
  const m = String(content).match(/<!--\s*state:\s*({[\s\S]*?})\s*-->/i);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

async function loadState(messageId, messageContent) {
  if (HAVE_REDIS) {
    const j = await redis('GET', `state:${messageId}`);
    if (j?.result) { try { return JSON.parse(j.result); } catch {} }
  }
  return extractStateFromContent(messageContent) || null;
}

async function saveState(messageId, state) {
  if (HAVE_REDIS) {
    await redis('SET', `state:${messageId}`, JSON.stringify(state));
  }
}

// ============ business ops ============
function removeFromAll(state, userId) {
  for (const k of Object.keys(state.members)) {
    state.members[k] = state.members[k].filter(id => id !== userId);
  }
}
function applyJoin(state, groupNo, userId) {
  const key = String(groupNo);
  if (state.members[key]?.includes(userId)) return { ok: false, msg: '你已在此團' };
  if (!state.multi) removeFromAll(state, userId);
  const remain = state.max[groupNo - 1] - (state.members[key]?.length || 0);
  if (remain <= 0) return { ok: false, msg: '此團已滿' };
  state.members[key] ??= [];
  state.members[key].push(userId);
  return { ok: true };
}
function applyLeave(state, groupNo, userId) {
  const key = String(groupNo);
  const pos = state.members[key]?.indexOf(userId) ?? -1;
  if (pos === -1) return { ok: false, msg: '你不在此團' };
  state.members[key].splice(pos, 1);
  return { ok: true };
}
function renderViewAll(state) {
  const lines = [];
  lines.push('**目前名單：**');
  for (let i = 0; i < state.max.length; i++) {
    const k = String(i + 1);
    const arr = state.members[k] || [];
    const list = arr.length ? arr.map(id => `<@${id}>`).join('、') : '（無）';
    lines.push(`第${i + 1}團： ${list}`);
  }
  return lines.join('\n');
}

// ============ permission helper ============
function hasAdminPerm(member) {
  try {
    if (!member?.permissions) return false;
    const bits = BigInt(member.permissions);
    const ADMIN = 1n << 3n; // Administrator
    return (bits & ADMIN) !== 0n;
  } catch { return false; }
}
function isManager(itx, state) {
  const uid = itx.member?.user?.id || itx.user?.id || '';
  if (!uid) return false;
  return uid === state.ownerId || hasAdminPerm(itx.member);
}

// ============ admin panel builders ============
function buildAdminPanel(state) {
  // 1) 成員選單（最多 25）
  const options = [];
  for (let i = 0; i < state.max.length; i++) {
    const n = i + 1;
    for (const uid of state.members[String(n)] || []) {
      const label = `第${n}團 - ${uid}`;
      options.push({ label, value: `${uid}:${n}`, description: `user:${uid}` });
      if (options.length >= 25) break;
    }
    if (options.length >= 25) break;
  }
  const rows = [];
  rows.push({
    type: 1,
    components: [{
      type: 3, // String select
      custom_id: 'admin_user',
      placeholder: options.length ? '選擇成員' : '目前沒有成員',
      min_values: 1,
      max_values: 1,
      options: options.length ? options : [{ label: '（無成員）', value: 'none:none', description: '—' }],
    }],
  });
  // 2) 動作列：踢出 / 移組
  rows.push({
    type: 1,
    components: [
      { type: 2, style: 4, custom_id: 'adm_kick', label: '踢出' },
    ],
  });
  // 3) 目標群列（五顆一排）
  const perRow = 5;
  let row = { type: 1, components: [] };
  for (let i = 1; i <= state.max.length; i++) {
    row.components.push({ type: 2, style: 1, custom_id: `adm_move_${i}`, label: `移到第${i}團` });
    if (row.components.length === perRow) {
      rows.push(row);
      row = { type: 1, components: [] };
    }
  }
  if (row.components.length) rows.push(row);
  return rows;
}

// ============ HTTP handler ============
export default async function handler(req, res) {
  if (req.method === 'HEAD') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const sig = req.headers['x-signature-ed25519'];
  const ts  = req.headers['x-signature-timestamp'];
  const raw = await readRawBody(req);

  try {
    const ok = await verifyKey(raw, sig, ts, PUBLIC_KEY);
    if (!ok) return res.status(401).send('invalid request signature');
  } catch {
    return res.status(401).send('invalid request signature');
  }

  const itx = JSON.parse(raw);

  if (itx.type === InteractionType.PING) {
    return res.status(200).json({ type: InteractionResponseType.PONG });
  }

  if (VERIFY_ONLY) {
    return res.status(200).json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'OK（verify-only）', flags: 64 },
    });
  }

  // ---- Slash: /cteam ----
  if (itx.type === InteractionType.APPLICATION_COMMAND && itx.data?.name === 'cteam') {
    res.status(200).json({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

    (async () => {
      try {
        const opts = Object.fromEntries((itx.data.options || []).map(o => [o.name, o.value]));
        const caps  = String(opts.caps ?? '5,5,5').split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n >= 0);
        if (!caps.length) throw new Error('caps 格式錯誤');
        const multi = Boolean(opts.multi ?? false);
        const title = String(opts.title ?? '').slice(0, 200);
        const defs  = parseDefaults(opts.defaults);
        const ownerId = itx.member?.user?.id || itx.user?.id || '';

        const state = emptyState(caps, title, multi, ownerId);
        for (const [k, ids] of Object.entries(defs)) {
          const idx = parseInt(k, 10);
          if (!Number.isInteger(idx) || idx < 1 || idx > caps.length) continue;
          state.members[String(idx)] = Array.from(new Set(ids)).slice(0, caps[idx - 1]);
        }

        const content    = buildContentFromState(state);
        const components = buildComponents(state);

        await discordFetch(
          `https://discord.com/api/v10/webhooks/${itx.application_id}/${itx.token}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              content,
              components,
              allowed_mentions: { parse: [] },
            }),
          }
        );
      } catch (e) {
        await discordFetch(
          `https://discord.com/api/v10/webhooks/${itx.application_id}/${itx.token}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: `建立失敗：${e.message || e}`, flags: 64 }),
          }
        );
      }
    })();

    return;
  }

  // ---- Components ----
  if (itx.type === InteractionType.MESSAGE_COMPONENT) {
    res.status(200).json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });

    (async () => {
      const message  = itx.message;
      const customId = itx.data?.custom_id || '';
      const userId   = itx.member?.user?.id || itx.user?.id || '';
      const appId    = itx.application_id;
      const token    = itx.token;
      const msgId    = message?.id;

      try {
        // 查看名單（ephemeral）
        if (customId === 'view_all') {
          const state = (await loadState(msgId, message.content)) || extractStateFromContent(message.content);
          const text = state ? renderViewAll(state) : '讀取名單失敗';
          await discordFetch(
            `https://discord.com/api/v10/webhooks/${appId}/${token}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ content: text, flags: 64 }),
            }
          );
          return;
        }

        // 管理入口：admin_manage（只有 owner/admin 可用）
        if (customId === 'admin_manage') {
          const state = (await loadState(msgId, message.content)) || extractStateFromContent(message.content);
          if (!state) {
            await discordFetch(`https://discord.com/api/v10/webhooks/${appId}/${token}`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ content: '讀取狀態失敗', flags: 64 }),
            });
            return;
          }
          if (!isManager(itx, state)) {
            await discordFetch(`https://discord.com/api/v10/webhooks/${appId}/${token}`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ content: '你沒有管理權限', flags: 64 }),
            });
            return;
          }
          const rows = buildAdminPanel(state);
          await discordFetch(
            `https://discord.com/api/v10/webhooks/${appId}/${token}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                content: '管理面板：先選成員，再按「踢出」或「移到第 N 團」。',
                flags: 64,
                components: rows,
                allowed_mentions: { parse: [] },
              }),
            }
          );
          return;
        }

        // 管理：選擇成員（string select）
        if (customId === 'admin_user') {
          const v = itx.data?.values?.[0] || '';
          const m = v.match(/^(\d+):(\d+)$/);
          if (!m) {
            await discordFetch(`https://discord.com/api/v10/webhooks/${appId}/${token}`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ content: '選擇無效', flags: 64 }),
            });
            return;
          }
          const tgtUser = m[1];
          const fromGrp = parseInt(m[2], 10);
          // 暫存到管理上下文（key: msgId + operator）
          await setEphemeral(`${msgId}:${userId}`, { target: tgtUser, from: fromGrp }, 120000);
          await discordFetch(`https://discord.com/api/v10/webhooks/${appId}/${token}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: `已選擇：<@${tgtUser}>（第${fromGrp}團）。接著點「踢出」或「移到第 N 團」。`, flags: 64 }),
          });
          return;
        }

        // 管理：踢出/移組
        const mv = customId.match(/^adm_move_(\d+)$/);
        const isKick = customId === 'adm_kick';
        if (isKick || mv) {
          const ctx = await getEphemeral(`${msgId}:${userId}`);
          if (!ctx?.target) {
            await discordFetch(`https://discord.com/api/v10/webhooks/${appId}/${token}`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ content: '請先在下拉選單選擇成員', flags: 64 }),
            });
            return;
          }
          const dest = isKick ? null : parseInt(mv[1], 10);

          await withLock(`lock:${msgId}`, 3000, async () => {
            let state = await loadState(msgId, message.content);
            if (!state) state = extractStateFromContent(message.content);
            if (!state) throw new Error('讀取狀態失敗');

            if (!isManager(itx, state)) throw new Error('你沒有管理權限');

            if (isKick) {
              removeFromAll(state, ctx.target);
            } else {
              removeFromAll(state, ctx.target);
              const r = applyJoin(state, dest, ctx.target);
              if (!r.ok) throw new Error(`移動失敗：${r.msg}`);
            }
            state.version = (state.version || 0) + 1;
            await saveState(msgId, state);

            const content    = buildContentFromState(state);
            const components = buildComponents(state);

            await discordFetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ content, components, allowed_mentions: { parse: [] } }),
            });
          });

          const done = isKick ? `已踢出 <@${ctx.target}>` : `已將 <@${ctx.target}> 移到第${dest}團`;
          await discordFetch(`https://discord.com/api/v10/webhooks/${appId}/${token}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: done, flags: 64 }),
          });
          return;
        }

        // 一般 join / leave
        const jm = customId.match(/^(join|leave)_(\d+)$/);
        if (jm) {
          const action  = jm[1];
          const groupNo = parseInt(jm[2], 10);

          await withLock(`lock:${msgId}`, 3000, async () => {
            let state = await loadState(msgId, message.content);
            if (!state) state = extractStateFromContent(message.content) || emptyState([5,5,5], '', false);

            let result;
            if (action === 'join') result = applyJoin(state, groupNo, userId);
            else                   result = applyLeave(state, groupNo, userId);

            if (result?.ok === false) {
              await discordFetch(`https://discord.com/api/v10/webhooks/${appId}/${token}`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ content: result.msg, flags: 64 }),
              });
            }

            state.version = (state.version || 0) + 1;
            await saveState(msgId, state);

            const content    = buildContentFromState(state);
            const components = buildComponents(state);

            await discordFetch(`https://discord.com/api/v10/webhooks/${appId}/${token}/messages/@original`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ content, components, allowed_mentions: { parse: [] } }),
            });
          });
          return;
        }
      } catch (e) {
        await discordFetch(
          `https://discord.com/api/v10/webhooks/${appId}/${token}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: `處理失敗：${e.message || e}`, flags: 64 }),
          }
        );
      }
    })();

    return;
  }

  return res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: '未處理的互動類型', flags: 64 },
  });
}
