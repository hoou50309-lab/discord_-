export default async function handler(req, res) {
  try {
    if (req.method !== 'PUT') {
      return res.status(405).json({ ok: false, error: 'Use PUT' });
    }

    // 驗管理金鑰
    const adminKey = req.headers['x-admin-key'];
    if (!process.env.ADMIN_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing env ADMIN_KEY' });
    }
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(401).json({ ok: false, error: 'Bad x-admin-key' });
    }

    const APP_ID = process.env.APP_ID;
    const BOT_TOKEN = process.env.BOT_TOKEN;
    if (!APP_ID || !BOT_TOKEN) {
      return res.status(500).json({ ok: false, error: 'Missing env APP_ID or BOT_TOKEN' });
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

    const scope = String(req.query.scope || '');
    const guilds = String(req.query.guilds || '')
      .split(',').map(s => s.trim()).filter(Boolean);
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
      const url = `https://discord.com/api/v10/applications/${APP_ID}/commands`;
      results.push(await put(url, clear ? [] : commands));
    } else if (guilds.length) {
      for (const gid of guilds) {
        const url = `https://discord.com/api/v10/applications/${APP_ID}/guilds/${gid}/commands`;
        results.push(await put(url, clear ? [] : commands));
      }
    } else {
      return res.status(400).json({
        ok: false,
        error: 'Provide ?scope=global or ?guilds=ID[,ID2] (optional &clear=true)',
      });
    }

    return res.status(200).json({ ok: true, results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

// 不需要 raw body
export const config = { api: { bodyParser: true } };
