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
 * /cteam 參數處理
 * ========================= */
function getOpt(opts, name) { return opts?.find(o => o.name === name)?.value; }
function parseCaps(opts) {
  const raw = getOpt(opts, 'caps');
  if (!raw) return [12, 12, 12];
  const arr = String(raw)
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n) && n >= 0);
  return arr.length ? arr : [12, 12, 12];
}

/* =========================
 * /cteam 初始狀態構建
 * ========================= */
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

    let defaults = '';
    const attachTxt = await loadDefaultsFromAttachment(interaction, 'defaults');
    if (attachTxt) {
      defaults = attachTxt;
    } else {
      defaults = getOpt(opts, 'defaults') || '';
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
