// /api/register.js（節錄與關鍵修改）

export default async function handler(req, res) {
  try {
    if (req.method !== 'PUT') {
      return res.status(405).json({ ok: false, error: 'Use PUT' });
    }

    // 簡單管理金鑰檢查
    const adminKey = req.headers['x-admin-key'];
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(401).json({ ok: false, error: 'Bad x-admin-key' });
    }

    const APP_ID = process.env.APP_ID;
    const BOT_TOKEN = process.env.BOT_TOKEN;
    if (!APP_ID || !BOT_TOKEN) {
      return res.status(500).json({ ok: false, error: 'Missing APP_ID/BOT_TOKEN' });
    }

    const commands = [{
      name: 'cteam',
      description: '建立分組名單',
      type: 1,
      options: [
        { name: 'caps', description: '各團名額，例: 5,3,2', type: 3, required: false },
        { name: 'multi', description: '允許多團', type: 5, required: false },
        { name: 'title', description: '標題', type: 3, required: false },
        { name: 'defaults', description: '預設名單（每行: 團號: @A @B）', type: 3, required: false },
      ],
    }];

    // ---- 這裡開始是重點：支援多來源 guild id ----
    const qsGuilds = String(req.query.guilds || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    const envList = (process.env.GUILD_IDS || '')
      .split(/[,\s]+/).map(s => s.trim()).filter(Boolean);

    const envIndexed = Object.entries(process.env)
      .filter(([k]) => k.startsWith('GUILD_ID_')) // GUILD_ID_1, GUILD_ID_2, ...
      .map(([, v]) => String(v).trim())
      .filter(Boolean);

    // 也順手支援單一 GUILD_ID
    const maybeSingle = process.env.GUILD_ID ? [String(process.env.GUILD_ID).trim()] : [];

    const envGuilds = [...new Set([...envList, ...envIndexed, ...maybeSingle])];

    const guilds = qsGuilds.length ? qsGuilds : envGuilds;
    const scope = String(req.query.scope || '');
    const clear = String(req.query.clear || 'false').toLowerCase() === 'true';

    async function put(url, body) {
      const r = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bot ${BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, text };
    }

    const results = [];

    if (scope === 'global') {
      // 全域註冊（不需要 guild id）
      const url = `https://discord.com/api/v10/applications/${APP_ID}/commands`;
      results.push(await put(url, clear ? [] : commands));
    } else if (guilds.length) {
      // 依 env（或 query）列出的多個 guild 註冊
      for (const gid of guilds) {
        const url = `https://discord.com/api/v10/applications/${APP_ID}/guilds/${gid}/commands`;
        results.push(await put(url, clear ? [] : commands));
      }
    } else {
      // 既沒有 ?scope=global 也沒有 guild 清單
      return res.status(400).json({
        ok: false,
        error: 'Provide ?scope=global OR set GUILD_IDS / GUILD_ID_* / GUILD_ID (or pass ?guilds=ID[,ID2])',
      });
    }

    return res.status(200).json({ ok: true, results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

export const config = { api: { bodyParser: true } };
