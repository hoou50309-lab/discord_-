// api/discord.js
// ========= 高速  & 穩定版 =========
// - FAST_UPDATE: 先試同步計算 + 回 UPDATE_MESSAGE（type:7）=> 1 次往返；失敗再退回 defer+patch。
// - 支援 GET/HEAD: 給 Vercel Cron / 健康檢查，避免冷啟動。
// - Upstash Redis (可選) 作分散式鎖；沒有也能跑（會退回本地 latch）。
// - 內建 admin_manage（踢人 / 移組）只限開團者或管理員。
// - 狀態寫在訊息 content 的 HTML 註解，不吵人。
// - 可切換簽章驗證（VERIFY_SIGNATURE=false 預設關閉；要過安全檢查再開）。

import {
  InteractionType,
  InteractionResponseType,
  verifyKey
} from 'discord-interactions';

// ====== 速度 & 鎖設定 ======
const FAST_UPDATE = true;            // 優先走 type:7
const LOCK_TTL_SEC = 2;              // 分散式鎖 TTL（秒）
const FAST_TIMEOUT_MS = 2200;        // 快速路徑的最大時間（毫秒）
const REGION_HINT = 'iad1';          // 可配合 vercel.json functions.regions 使用（僅註釋）

// ====== 簽章驗證開關 ======
const VERIFY_SIGNATURE = (process.env.VERIFY_SIGNATURE || 'false').toLowerCase() === 'true';

// ====== Upstash（可選）=====
const UP_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

async function upstash(cmd, ...args) {
  if (!UP_URL || !UP_TOKEN) return { ok: false };
  const body = [cmd, ...args].join(' ');
  const r = await fetch(UP_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UP_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  if (!r.ok) return { ok: false, status: r.status, text: await r.text() };
  const out = await r.json().catch(() => ({}));
  return { ok: true, ...out };
}
async function lockRedis(key, ttlSec) {
  const r = await upstash('SET', key, '1', 'EX', String(ttlSec), 'NX');
  return r.ok && r.result === 'OK';
}
async function unlockRedis(key) {
  await upstash('DEL', key);
}

// ====== 本地臨時 latch（保底）======
const localLatch = new Map();
function tryLocalLatch(k, ttlMs = LOCK_TTL_SEC * 1000) {
  const now = Date.now();
  const expireAt = localLatch.get(k);
  if (expireAt && expireAt > now) return false;
  localLatch.set(k, now + ttlMs);
  setTimeout(() => { if (localLatch.get(k) <= Date.now()) localLatch.delete(k); }, ttlMs + 100);
  return true;
}
function releaseLocalLatch(k) {
  localLatch.delete(k);
}

// ====== 鎖封裝 ======
async function withLock(key, ttlSec, fn) {
  const rkey = `lock:${key}`;
  let locked = false;
  let useRedis = Boolean(UP_URL && UP_TOKEN);

  if (useRedis) {
    locked = await lockRedis(rkey, ttlSec);
    if (!locked) return false;
  } else {
    locked = tryLocalLatch(rkey, ttlSec * 1000);
    if (!locked) return false;
  }

  try {
    await fn();
    return true;
  } finally {
    if (useRedis) await unlockRedis(rkey);
    else releaseLocalLatch(rkey);
  }
}

// ====== 工具 ======
async function readRawBody(req) {
  const bufs = [];
  for await (const c of req) bufs.push(c);
  return Buffer.concat(bufs).toString('utf8');
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const HAN = ['零','一','二','三','四','五','六','七','八','九','十','十一','十二','十三','十四','十五'];
const hn = (n) => HAN[n] ?? String(n);

// ====== 狀態結構 ======
// { title, caps: number[], members: { "1":[uid,...], ... }, multi:boolean, ownerId, messageId? }

// 1) 將 state 放在 HTML 註解（隱藏）
function encodeState(state) {
  const s = JSON.stringify({ ...state, messageId: undefined });
  return `<!--state:${s}-->`;
}
function decodeStateFrom(content = '') {
  const m = content.match(/<!--state:({[\s\S]*?})-->/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// 2) 建立主訊息內容（顯示暱稱：使用 <@userId> 讓 Discord 自動以暱稱呈現）
function buildContent(state) {
  const lines = [];
  if (state.title) lines.push(`${state.title}`);
  lines.push('目前名單：');
  for (let i = 1; i <= state.caps.length; i++) {
    const arr = state.members[String(i)] || [];
    const mentions = arr.length ? arr.map(id => `<@${id}>`).join('、') : '（無）';
    lines.push(`第${hn(i)}團（-${state.caps[i-1]}）\n${mentions}`);
  }
  // 狀態註解（隱藏）
  lines.push(encodeState(state));
  return lines.join('\n');
}

// 3) 主按鈕
function buildMainButtons(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      type: 1,
      components: [
        { type: 2, style: 3, label: `加入第${hn(i)}團`, custom_id: `join_${i}` },
        { type: 2, style: 2, label: `離開第${hn(i)}團`, custom_id: `leave_${i}` },
      ]
    });
  }
  // 管理選單觸發（只顯示一顆按鈕）
  rows.push({
    type: 1,
    components: [
      { type: 2, style: 1, label: '管理名單（踢人 / 移組）', custom_id: 'admin_open' }
    ]
  });
  return rows;
}

// 4) 管理面板：踢人/選人移組
function buildAdminPanelSelects(state) {
  const optsKick = [];
  const optsPick = [];
  for (let i = 1; i <= state.caps.length; i++) {
    const arr = state.members[String(i)] || [];
    for (const uid of arr) {
      optsKick.push({ label: `踢出：第${hn(i)}團 @${uid}`, value: `kick:${i}:${uid}` });
      optsPick.push({ label: `移組：第${hn(i)}團 @${uid}`, value: `pick:${i}:${uid}` });
    }
  }
  const rows = [];
  rows.push({
    type: 1,
    components: [{
      type: 3, custom_id: 'admin_manage:kick',
      placeholder: '選擇要踢出的成員（可多選）',
      min_values: 1, max_values: Math.max(1, optsKick.length) || 1,
      options: optsKick.slice(0, 25) // 單選單最多 25 筆
    }]
  });
  rows.push({
    type: 1,
    components: [{
      type: 3, custom_id: 'admin_manage:pickmove',
      placeholder: '選擇要移組的成員（一次一位）',
      min_values: 1, max_values: 1,
      options: optsPick.slice(0, 25)
    }]
  });
  return rows;
}
function buildMoveToSelect(state, uid, fromIdx) {
  const opts = [];
  for (let i = 1; i <= state.caps.length; i++) {
    if (i === fromIdx) continue;
    opts.push({ label: `第${hn(i)}團（剩 ${state.caps[i-1]}）`, value: String(i) });
  }
  return [{
    type: 1,
    components: [{
      type: 3,
      custom_id: `admin_manage:to:${uid}:${fromIdx}`,
      placeholder: '選擇目的團',
      min_values: 1, max_values: 1,
      options: opts.slice(0, 25)
    }]
  }];
}

// 5) 權限判斷：開團者或伺服器管理員
function hasAdmin(interaction, state) {
  const me = interaction.member;
  const uid = me?.user?.id || interaction.user?.id;
  if (uid && state.ownerId && uid === state.ownerId) return true;
  const perms = me?.permissions;
  if (!perms) return false;
  const bit = BigInt(perms);
  // 管理員（0x8）
  return (bit & 0x0000000000000008n) !== 0n;
}

// 6) Webhook / API 工具
async function followupEphemeral(interaction, content) {
  try {
    await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, flags: 64, allowed_mentions: { parse: [] } })
    });
  } catch {}
}
async function postEphemeral(interaction, payload) {
  try {
    await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, flags: 64, allowed_mentions: { parse: [] } })
    });
  } catch {}
}
async function patchOriginal(interaction, state) {
  try {
    await fetch(`https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: buildContent(state),
        components: buildMainButtons(state.caps.length),
        allowed_mentions: { parse: [] }
      })
    });
  } catch {}
}

// 7) 暫存（開團時把 state 放到 boot:token，待第一次 PATCH/UPDATE 後就以訊息內部註解為準）
async function kvSetBoot(token, state) {
  if (!UP_URL || !UP_TOKEN) return;
  await upstash('SETEX', `boot:${token}`, '180', JSON.stringify(state));
}
async function kvGetBoot(token) {
  if (!UP_URL || !UP_TOKEN) return null;
  const r = await upstash('GET', `boot:${token}`);
  if (!r.ok || r.result == null) return null;
  try { return JSON.parse(r.result); } catch { return null; }
}
async function kvDelBoot(token) {
  if (!UP_URL || !UP_TOKEN) return;
  await upstash('DEL', `boot:${token}`);
}

// 8) 狀態載入/儲存（本檔使用「訊息註解」為主）
async function loadStateFromMessage(message) {
  const content = message?.content || '';
  return decodeStateFrom(content);
}
async function saveStateByUpdateResponse(state) {
  // 交由 UPDATE_MESSAGE / PATCH 寫回 content 註解
  return;
}

// ============ 處理器 ============
export default async function handler(req, res) {
  // 健康檢查 / cron：避免冷啟動
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.status(200).send('ok');
  }
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const rawBody = await readRawBody(req);
  if (VERIFY_SIGNATURE) {
    const sig = req.headers['x-signature-ed25519'];
    const ts  = req.headers['x-signature-timestamp'];
    if (!sig || !ts) return res.status(401).send('Bad signature');
    const ok = await verifyKey(rawBody, sig, ts, process.env.PUBLIC_KEY);
    if (!ok) return res.status(401).send('Bad signature');
  }

  const interaction = JSON.parse(rawBody);

  // PING
  if (interaction.type === InteractionType.PING) {
    return res.status(200).json({ type: InteractionResponseType.PONG });
  }

  // Slash：/cteam
  if (interaction.type === InteractionType.APPLICATION_COMMAND && interaction.data?.name === 'cteam') {
    try {
      const options = Object.fromEntries((interaction.data.options || []).map(o => [o.name, o.value]));
      const capsStr = options.caps ? String(options.caps) : '12,12,12';
      const caps = capsStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n >= 0);
      if (!caps.length) {
        return res.status(200).json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { flags: 64, content: '名額格式錯誤，請用「12,12,12」' }
        });
      }
      const multi = Boolean(options.multi);
      const title = (options.title || '').trim();

      // 預設名單（選用）
      const defaults = (options.defaults || '').trim();
      const members = Object.fromEntries(Array.from({ length: caps.length }, (_, i) => [String(i+1), []]));
      if (defaults) {
        // 解析格式：1: <@id> <@id>\n2: <@id>
        for (const line of defaults.split('\n')) {
          const m = line.trim().match(/^(\d+)\s*:\s*(.*)$/);
          if (!m) continue;
          const gi = parseInt(m[1], 10);
          const rest = m[2] || '';
          if (!members[String(gi)]) continue;
          const ids = Array.from(rest.matchAll(/<@!?(\d+)>/g)).map(mm => mm[1]);
          for (const uid of ids) {
            if (!members[String(gi)].includes(uid)) {
              members[String(gi)].push(uid);
              if (caps[gi-1] > 0) caps[gi-1] -= 1;
            }
          }
        }
      }

      const ownerId = interaction.member?.user?.id || interaction.user?.id || '';
      const state = { title, caps, members, multi, ownerId };

      // 暫存 boot:token（等第一次更新訊息就可從 content 註解拿）
      await kvSetBoot(interaction.token, state);

      // 直接回覆新訊息
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: buildContent(state),
          components: buildMainButtons(caps.length),
          allowed_mentions: { parse: [] }
        }
      });
    } catch (e) {
      console.error('cteam error', e);
      return res.status(200).json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: 64, content: '發生錯誤，請稍後重試。' }
      });
    }
  }

  // 按鈕/選單
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const customId = interaction.data?.custom_id || '';
    const message  = interaction.message;
    const messageId = message?.id;
    const userId = interaction.member?.user?.id || interaction.user?.id || '';

    // --- FAST 路徑：嘗試在 2.2s 內完成並直接回 type:7 ---
    if (FAST_UPDATE) {
      const done = await Promise.race([
        (async () => {
          // 讀 state（優先訊息註解；若新訊息尚未寫入，取 boot:token）
          let state = await loadStateFromMessage(message)
                   || await kvGetBoot(interaction.token);
          if (!state) state = { title: '', caps: [1,1,1], members: { '1':[], '2':[], '3':[] }, multi:false, ownerId: '' };
          state.messageId = messageId;

          // admin 面板只開一個 ephemeral，不用鎖
          if (customId === 'admin_open') {
            if (!hasAdmin(interaction, state)) {
              await followupEphemeral(interaction, '只有開團者或伺服器管理員可以使用管理功能。');
            } else {
              const comps = buildAdminPanelSelects(state);
              await postEphemeral(interaction, { content: '管理名單（踢人 / 移組）', components: comps });
            }
            // 用 defer 去清 loading 泡泡，或直接 UPDATE_MESSAGE（無更新也可）
            return res.status(200).json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
          }

          const lockKey = `msg:${messageId}`;
          let updatedData = null;

          const ok = await withLock(lockKey, LOCK_TTL_SEC, async () => {
            // 依 customId 變更 state
            const m = customId.match(/^(join|leave)_(\d+)$/);
            if (m) {
              const action = m[1];
              const idx = parseInt(m[2], 10);
              const myGroups = Object.entries(state.members)
                .filter(([, arr]) => arr.includes(userId))
                .map(([k]) => parseInt(k, 10));

              if (action === 'join') {
                if (!state.multi && myGroups.length > 0 && !myGroups.includes(idx)) {
                  await followupEphemeral(interaction, '你已加入其他團，未開啟「允許多團」。');
                } else if (state.caps[idx - 1] <= 0) {
                  await followupEphemeral(interaction, `第${hn(idx)}團名額已滿。`);
                } else {
                  const arr = state.members[String(idx)];
                  if (!arr.includes(userId)) {
                    arr.push(userId);
                    state.caps[idx - 1] -= 1;
                  } else {
                    await followupEphemeral(interaction, `你已在第${hn(idx)}團。`);
                  }
                }
              } else {
                const arr = state.members[String(idx)];
                const pos = arr.indexOf(userId);
                if (pos === -1) {
                  await followupEphemeral(interaction, `你不在第${hn(idx)}團。`);
                } else {
                  arr.splice(pos, 1);
                  state.caps[idx - 1] += 1;
                }
              }
            }

            if (customId.startsWith('admin_manage:')) {
              if (!hasAdmin(interaction, state)) {
                await followupEphemeral(interaction, '只有開團者或伺服器管理員可以使用管理功能。');
              } else {
                const action = customId.split(':')[1]; // kick / pickmove / to:uid:from
                if (action === 'kick') {
                  const v = interaction.data.values?.[0];
                  const mm = v?.match(/^kick:(\d+):(\d+)$/);
                  if (mm) {
                    const g = parseInt(mm[1], 10);
                    const uid = mm[2];
                    const arr = state.members[String(g)] || [];
                    const pos = arr.indexOf(uid);
                    if (pos !== -1) {
                      arr.splice(pos, 1);
                      state.caps[g-1] += 1;
                      await followupEphemeral(interaction, `已將 <@${uid}> 踢出第${hn(g)}團。`);
                    } else {
                      await followupEphemeral(interaction, '該成員不在此團。');
                    }
                  }
                } else if (action === 'pickmove') {
                  const v = interaction.data.values?.[0];
                  const mm = v?.match(/^pick:(\d+):(\d+)$/);
                  if (mm) {
                    const fromIdx = parseInt(mm[1], 10);
                    const uid = mm[2];
                    const comps = buildMoveToSelect(state, uid, fromIdx);
                    await postEphemeral(interaction, { content: `選擇 <@${uid}> 的目的團：`, components: comps });
                  }
                } else if (action.startsWith('to')) {
                  const seg = customId.split(':'); // admin_manage:to:{uid}:{from}
                  const moveId = seg[2];
                  const fromIdx = parseInt(seg[3], 10);
                  const toIdx = parseInt(interaction.data.values?.[0] || '0', 10);
                  if (toIdx && toIdx !== fromIdx) {
                    if (state.caps[toIdx - 1] <= 0) {
                      await followupEphemeral(interaction, `第${hn(toIdx)}團名額已滿。`);
                    } else {
                      const fromArr = state.members[String(fromIdx)] || [];
                      const pos = fromArr.indexOf(moveId);
                      if (pos === -1) {
                        await followupEphemeral(interaction, '該成員已不在原團。');
                      } else {
                        fromArr.splice(pos, 1);
                        state.caps[fromIdx - 1] += 1;
                        const toArr = state.members[String(toIdx)] || [];
                        if (!toArr.includes(moveId)) {
                          toArr.push(moveId);
                          state.caps[toIdx - 1] -= 1;
                        }
                        await followupEphemeral(interaction,
                          `已將 <@${moveId}> 從第${hn(fromIdx)}團移至第${hn(toIdx)}團。`);
                      }
                    }
                  }
                }
              }
            }

            // 更新訊息資料（一次回傳就寫回 content 註解）
            const data = {
              content: buildContent(state),
              components: buildMainButtons(state.caps.length),
              allowed_mentions: { parse: [] }
            };
            updatedData = data;
          });

          if (!ok) {
            // 拿不到鎖 → 改走保險路徑（defer + 背景 patch）
            throw new Error('lock-failed');
          }

          // 成功 → 直接回 UPDATE_MESSAGE
          if (updatedData) {
            return res.status(200).json({
              type: InteractionResponseType.UPDATE_MESSAGE,
              data: updatedData
            });
          }
          // 沒東西要更新也可以回 defer 清除 loading
          return res.status(200).json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
        })(),
        sleep(FAST_TIMEOUT_MS).then(() => 'timeout')
      ]);

      if (done !== 'timeout') return; // 已經回應
      // 超時 → 落至保險路徑
    }

    // --- 保險路徑：DEFER + 背景 PATCH ---
    res.status(200).json({ type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE });
    (async () => {
      try {
        let state = await loadStateFromMessage(message)
                  || await kvGetBoot(interaction.token);
        if (!state) return; // 無 state，略過
        state.messageId = messageId;

        const lockKey = `msg:${messageId}`;
        await withLock(lockKey, LOCK_TTL_SEC, async () => {
          const m = customId.match(/^(join|leave)_(\d+)$/);
          if (m) {
            const action = m[1];
            const idx = parseInt(m[2], 10);
            const myGroups = Object.entries(state.members)
              .filter(([, arr]) => arr.includes(userId))
              .map(([k]) => parseInt(k, 10));
            if (action === 'join') {
              if (!state.multi && myGroups.length > 0 && !myGroups.includes(idx)) {
                await followupEphemeral(interaction, '你已加入其他團，未開啟「允許多團」。');
              } else if (state.caps[idx - 1] <= 0) {
                await followupEphemeral(interaction, `第${hn(idx)}團名額已滿。`);
              } else {
                const arr = state.members[String(idx)];
                if (!arr.includes(userId)) {
                  arr.push(userId);
                  state.caps[idx - 1] -= 1;
                } else {
                  await followupEphemeral(interaction, `你已在第${hn(idx)}團。`);
                }
              }
            } else {
              const arr = state.members[String(idx)];
              const pos = arr.indexOf(userId);
              if (pos === -1) {
                await followupEphemeral(interaction, `你不在第${hn(idx)}團。`);
              } else {
                arr.splice(pos, 1);
                state.caps[idx - 1] += 1;
              }
            }
          }

          if (customId.startsWith('admin_manage:')) {
            if (!hasAdmin(interaction, state)) {
              await followupEphemeral(interaction, '只有開團者或伺服器管理員可以使用管理功能。');
            } else {
              const action = customId.split(':')[1];
              if (action === 'kick') {
                const v = interaction.data.values?.[0];
                const mm = v?.match(/^kick:(\d+):(\d+)$/);
                if (mm) {
                  const g = parseInt(mm[1], 10);
                  const uid = mm[2];
                  const arr = state.members[String(g)] || [];
                  const pos = arr.indexOf(uid);
                  if (pos !== -1) {
                    arr.splice(pos, 1); state.caps[g-1] += 1;
                    await followupEphemeral(interaction, `已將 <@${uid}> 踢出第${hn(g)}團。`);
                  } else {
                    await followupEphemeral(interaction, '該成員不在此團。');
                  }
                }
              } else if (action === 'pickmove') {
                const v = interaction.data.values?.[0];
                const mm = v?.match(/^pick:(\d+):(\d+)$/);
                if (mm) {
                  const fromIdx = parseInt(mm[1], 10);
                  const uid = mm[2];
                  const comps = buildMoveToSelect(state, uid, fromIdx);
                  await postEphemeral(interaction, { content: `選擇 <@${uid}> 的目的團：`, components: comps });
                }
              } else if (action.startsWith('to')) {
                const seg = customId.split(':'); // to:uid:from
                const moveId = seg[2];
                const fromIdx = parseInt(seg[3], 10);
                const toIdx = parseInt(interaction.data.values?.[0] || '0', 10);
                if (toIdx && toIdx !== fromIdx) {
                  if (state.caps[toIdx - 1] <= 0) {
                    await followupEphemeral(interaction, `第${hn(toIdx)}團名額已滿。`);
                  } else {
                    const fromArr = state.members[String(fromIdx)] || [];
                    const pos = fromArr.indexOf(moveId);
                    if (pos === -1) {
                      await followupEphemeral(interaction, '該成員已不在原團。');
                    } else {
                      fromArr.splice(pos, 1);
                      state.caps[fromIdx - 1] += 1;
                      const toArr = state.members[String(toIdx)] || [];
                      if (!toArr.includes(moveId)) {
                        toArr.push(moveId);
                        state.caps[toIdx - 1] -= 1;
                      }
                      await followupEphemeral(interaction,
                        `已將 <@${moveId}> 從第${hn(fromIdx)}團移至第${hn(toIdx)}團。`);
                    }
                  }
                }
              }
            }
          }

          await patchOriginal(interaction, state);
        });
      } catch (e) {
        console.error('component error', e);
        await followupEphemeral(interaction, '系統忙碌，請稍後重試。');
      } finally {
        await kvDelBoot(interaction.token).catch(()=>{});
      }
    })();
    return;
  }

  // 其他互動：忽略
  return res.status(200).json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: 64, content: '未處理的互動類型。' }
  });
}
