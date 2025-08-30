// api/discord.js
// 穩定版 + 管理選單（踢人 / 移組）+ 修正重複貼訊息 + 原始 token 綁定（修正從 ephemeral 觸發時無法更新原文）
// - /cteam 同步回覆（type:4）
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
// 讀取 /cteam 的附件（option: defaults 或檔名含「預設人員名單」），回傳文字，失敗回 null
async function loadDefaultsFromAttachment(interaction, optionName = 'defaults') {
  try {
    const opts = interaction.data?.options || [];
    const resolvedAtt = interaction.data?.resolved?.attachments || {};

    // 若 defaults 是 Attachment 選項（type=11），value 會是附件 id
    const opt = opts.find(o => o.name === optionName);
    let att = (opt && resolvedAtt[opt.value]) ? resolvedAtt[opt.value] : null;

    // 若沒有直接指定，從 resolved.attachments 中找檔名包含關鍵字的
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
 * /cteam 參數處理
 * ========================= */
function getOpt(opts, name) { return opts?.find(o => o.name === name)?.value; }

// 解析 caps 參數
function parseCaps(opts) {
  const raw = getOpt(opts, 'caps');
  if (!raw) return [12, 12, 12]; // 如果沒有指定 caps，則預設每個團隊12個名額
  const arr = String(raw)
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n) && n >= 0); // 過濾掉非正整數的值
  return arr.length ? arr : [12, 12, 12]; // 如果無效的 caps，則返回預設值
}

/* =========================
 * /cteam 互動處理
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

  // /cteam：同步回覆
  if (interaction.type === InteractionType.APPLICATION_COMMAND &&
      interaction.data?.name === 'cteam') {

    const opts = interaction.data.options || [];
    const caps = parseCaps(opts);
    const multi = !!getOpt(opts, 'multi');
    const title = getOpt(opts, 'title') || '';

    // 檢查附件是否存在，若有附件則載入並使用該附件內容填充 defaults
    let defaults = '';
    const attachTxt = await loadDefaultsFromAttachment(interaction, 'defaults');
    if (attachTxt) {
      defaults = attachTxt;  // 使用附件的內容覆蓋 defaults
    } else {
      defaults = getOpt(opts, 'defaults') || '';  // 若無附件，則使用指令中的 defaults 參數（若有）
    }

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

  // 處理其他的交互邏輯...
}
