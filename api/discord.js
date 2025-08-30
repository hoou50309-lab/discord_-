// api/discord.js — Verify-Only + Stable Full Function (default verify-only ON)
import {
  InteractionType,
  InteractionResponseType,
  verifyKey,
} from 'discord-interactions';

export const config = { runtime: 'nodejs' };

// ===== utils =====
async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
const j = (res, code, obj) => res.status(code).json(obj);
const now = () => new Date().toISOString().slice(11, 19);

// env 開關：預設啟用 verify-only
const VERIFY_ONLY_DEFAULT =
  (process.env.VERIFY_ONLY ?? 'false').toString().toLowerCase() !== 'false';
function isVerifyOnly(req) {
  const q = (req.query?.verify ?? req.query?.mode)?.toString().toLowerCase();
  if (q === '1' || q === 'true' || q === 'verify') return true;
  if (q === '0' || q === 'false' || q === 'full') return false;
  const h = req.headers['x-verify-only']?.toString().toLowerCase();
  if (h === '1' || h === 'true') return true;
  if (h === '0' || h === 'false') return false;
  return VERIFY_ONLY_DEFAULT;
}

// ===== state helpers (hidden comment) =====
const STATE_RE = /<!--\s*state:\s*({[\s\S]*?})\s*-->/i;

function parseStateFrom(content) {
  const m = content.match(STATE_RE);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function setStateInContent(base, stateObj) {
  const cleaned = base.replace(STATE_RE, '').trim();
  return `${cleaned}\n\n<!-- state: ${JSON.stringify(stateObj)} -->`;
}

// ===== rendering =====
function mention(uid) {
  return `<@${uid}>`;
}
function renderMemberLine(ids) {
  if (!ids || ids.length === 0) return '（無）';
  return ids.map(mention).join(' ');
}
function renderContent(state) {
  const capLeft = state.caps; // 剩餘名額陣列
  const lines = [];
  if (state.title) lines.push(`${state.title}`);
  lines.push(
    `第一團（-${capLeft[0]}）`,
    ``,
    `第二團（-${capLeft[1]}）`,
    ``,
    `第三團（-${capLeft[2]}）`,
    ``,
    `目前名單：`,
    `第一團： ${renderMemberLine(state.members['1'])}`,
    `第二團： ${renderMemberLine(state.members['2'])}`,
    `第三團： ${renderMemberLine(state.members['3'])}`,
  );
  return lines.join('\n');
}

function buildComponents(state) {
  // Row1: Join buttons
  const row1 = {
    type: 1,
    components: [
      { type: 2, style: 3, custom_id: 'join_1', label: '加入第一團' },
      { type: 2, style: 3, custom_id: 'join_2', label: '加入第二團' },
      { type: 2, style: 3, custom_id: 'join_3', label: '加入第三團' },
    ],
  };
  // Row2: Leave buttons
  const row2 = {
    type: 1,
    components: [
      { type: 2, style: 2, custom_id: 'leave_1', label: '離開第一團' },
      { type: 2, style: 2, custom_id: 'leave_2', label: '離開第二團' },
      { type: 2, style: 2, custom_id: 'leave_3', label: '離開第三團' },
    ],
  };
  // Row3: View list
  const row3 = {
    type: 1,
    components: [
      { type: 2, style: 1, custom_id: 'view_all', label: '查看所有名單' },
    ],
  };

  // 管理用選單（所有人可見；只有 owner 可操作）
  // Select A: 踢人（列出所有成員）
  const kickOptions = [];
  for (const g of [1, 2, 3]) {
    for (const uid of state.members[String(g)]) {
      kickOptions.push({
        label: `第${g}團：${uid}`,
        value: `kick:${uid}:${g}`,
      });
    }
  }
  const row4 = {
    type: 1,
    components: [
      {
        type: 3, // string select
        custom_id: 'admin_kick',
        placeholder: '管理名單：踢人（開團者限定）',
        min_values: 1,
        max_values: 1,
        options: kickOptions.slice(0, 25), // 安全：最多 25
      },
    ],
  };

  // Select B: 移組（對每位成員產生目標組）
  const moveOptions = [];
  for (const from of [1, 2, 3]) {
    for (const uid of state.members[String(from)]) {
      for (const to of [1, 2, 3]) {
        if (to === from) continue;
        moveOptions.push({
          label: `將 ${uid}：第${from}→第${to}`,
          value: `move:${uid}:${from}:${to}`,
        });
      }
    }
  }
  const row5 = {
    type: 1,
    components: [
      {
        type: 3,
        custom_id: 'admin_move',
        placeholder: '管理名單：移組（開團者限定）',
        min_values: 1,
        max_values: 1,
        options: moveOptions.slice(0, 25),
      },
    ],
  };

  return [row1, row2, row3, row4, row5];
}

// ===== business logic =====

function ensureState(state) {
  // state: { title, caps:[n,n,n], members:{1:[],2:[],3:[]}, multi:false, owner:"id" }
  if (!state.members) {
    state.members = { '1': [], '2': [], '3': [] };
  } else {
    // 保證 key
    for (const k of ['1', '2', '3']) if (!state.members[k]) state.members[k] = [];
  }
  if (!state.caps) state.caps = [0, 0, 0];
  if (typeof state.multi !== 'boolean') state.multi = false;
  return state;
}

function inWhichGroup(state, uid) {
  const res = [];
  for (const g of [1, 2, 3]) {
    if (state.members[String(g)].includes(uid)) res.push(g);
  }
  return res;
}

function tryJoin(state, uid, g) {
  g = Number(g);
  // 不允許重複入多團
  const my = inWhichGroup(state, uid);
  if (!state.multi && my.length > 0) {
    return { ok: false, msg: `你已在第 ${my.join(',')} 團` };
  }
  if (state.members[String(g)].includes(uid)) {
    return { ok: false, msg: `你已在第${g}團` };
  }
  if (state.caps[g - 1] <= 0) {
    return { ok: false, msg: `第${g}團已滿` };
  }
  state.members[String(g)].push(uid);
  state.caps[g - 1] -= 1;
  return { ok: true };
}

function tryLeave(state, uid, g) {
  g = Number(g);
  const arr = state.members[String(g)];
  const idx = arr.indexOf(uid);
  if (idx === -1) return { ok: false, msg: `你不在第${g}團` };
  arr.splice(idx, 1);
  state.caps[g - 1] += 1;
  return { ok: true };
}

function tryKick(state, uid, g) {
  g = Number(g);
  const arr = state.members[String(g)];
  const idx = arr.indexOf(uid);
  if (idx === -1) return { ok: false, msg: `該成員不在第${g}團` };
  arr.splice(idx, 1);
  state.caps[g - 1] += 1;
  return { ok: true };
}

function tryMove(state, uid, from, to) {
  from = Number(from);
  to = Number(to);
  if (from === to) return { ok: false, msg: '來源與目標相同' };
  const arr = state.members[String(from)];
  const idx = arr.indexOf(uid);
  if (idx === -1) return { ok: false, msg: `該成員不在第${from}團` };
  if (state.caps[to - 1] <= 0) return { ok: false, msg: `第${to}團已滿` };
  arr.splice(idx, 1);
  state.caps[from - 1] += 1;
  state.members[String(to)].push(uid);
  state.caps[to - 1] -= 1;
  return { ok: true };
}

function rebuildMessage(state) {
  const content = setStateInContent(renderContent(state), state);
  const components = buildComponents(state);
  return { content, components };
}

// 解析 /cteam 參數
function parseCaps(str) {
  return String(str || '12,12,12')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .slice(0, 3)
    .concat([0, 0, 0])
    .slice(0, 3);
}

function parseDefaults(str) {
  // 例：
  // 1: <@111> <@222>
  // 2: <@333>
  // 3:
  const out = { '1': [], '2': [], '3': [] };
  if (!str) return out;
  const lines = String(str).split(/\r?\n/);
  for (const ln of lines) {
    const m = ln.match(/^\s*([123])\s*:\s*(.*)$/);
    if (!m) continue;
    const g = m[1];
    const rest = m[2];
    const ids = Array.from(rest.matchAll(/<@!?(\d+)>/g)).map((x) => x[1]);
    out[g].push(...ids);
  }
  return out;
}

// ===== FULL APP HANDLER =====
async function fullAppHandler(interaction, req, res) {
  // PING
  if (interaction.type === InteractionType.PING) {
    return j(res, 200, { type: InteractionResponseType.PONG });
  }

  // Slash: /cteam
  if (
    interaction.type === InteractionType.APPLICATION_COMMAND &&
    interaction.data?.name === 'cteam'
  ) {
    const opts = interaction.data.options || [];
    const getOpt = (name) => opts.find((o) => o.name === name)?.value;

    const caps = parseCaps(getOpt('caps'));
    const multi = !!getOpt('multi'); // 預設 false
    const title = getOpt('title') ? String(getOpt('title')) : '';
    const defaults = parseDefaults(getOpt('defaults'));

    // 初始 state
    const owner = interaction.member?.user?.id || interaction.user?.id;
    const state = ensureState({
      title,
      caps: [...caps],
      members: { '1': [], '2': [], '3': [] },
      multi,
      owner,
    });

    // 套預設名單
    for (const g of [1, 2, 3]) {
      for (const uid of defaults[String(g)]) {
        if (!state.members[String(g)].includes(uid) && state.caps[g - 1] > 0) {
          state.members[String(g)].push(uid);
          state.caps[g - 1] -= 1;
        }
      }
    }

    const { content, components } = rebuildMessage(state);

    return j(res, 200, {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content,
        components,
        allowed_mentions: { parse: [] }, // 不 ping
      },
    });
  }

  // Components
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    const cid = interaction.data?.custom_id || '';
    const message = interaction.message;
    const content = message?.content || '';
    const state = ensureState(parseStateFrom(content) || {});

    // 查看名單（ephemeral）
    if (cid === 'view_all') {
      const text =
        [
          `目前名單（${now()}）：`,
          `第一團： ${renderMemberLine(state.members['1'])}`,
          `第二團： ${renderMemberLine(state.members['2'])}`,
          `第三團： ${renderMemberLine(state.members['3'])}`,
        ].join('\n') || '無';
      return j(res, 200, {
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: text, flags: 64, allowed_mentions: { parse: [] } },
      });
    }

    // join / leave
    const m1 = cid.match(/^(join|leave)_(\d)$/);
    if (m1) {
      const act = m1[1];
      const g = Number(m1[2]);
      const uid = interaction.member?.user?.id || interaction.user?.id;

      let r;
      if (act === 'join') r = tryJoin(state, uid, g);
      else r = tryLeave(state, uid, g);

      if (!r.ok) {
        return j(res, 200, {
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: r.msg, flags: 64 },
        });
      }
      const { content: newContent, components: newComps } = rebuildMessage(
        state,
      );
      return j(res, 200, {
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: newContent,
          components: newComps,
          allowed_mentions: { parse: [] },
        },
      });
    }

    // 管理：踢人（string select）
    if (cid === 'admin_kick') {
      const owner = state.owner;
      const actor = interaction.member?.user?.id || interaction.user?.id;
      if (actor !== owner) {
        return j(res, 200, {
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '只有開團者可操作。', flags: 64 },
        });
      }
      const v = interaction.data?.values?.[0] || '';
      const mm = v.match(/^kick:(\d+):([123])$/);
      if (!mm) {
        return j(res, 200, {
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '格式錯誤。', flags: 64 },
        });
      }
      const uid = mm[1];
      const g = Number(mm[2]);
      const r = tryKick(state, uid, g);
      if (!r.ok) {
        return j(res, 200, {
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: r.msg, flags: 64 },
        });
      }
      const { content: newContent, components: newComps } = rebuildMessage(
        state,
      );
      return j(res, 200, {
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: newContent,
          components: newComps,
          allowed_mentions: { parse: [] },
        },
      });
    }

    // 管理：移組（string select）
    if (cid === 'admin_move') {
      const owner = state.owner;
      const actor = interaction.member?.user?.id || interaction.user?.id;
      if (actor !== owner) {
        return j(res, 200, {
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '只有開團者可操作。', flags: 64 },
        });
      }
      const v = interaction.data?.values?.[0] || '';
      const mm = v.match(/^move:(\d+):([123]):([123])$/);
      if (!mm) {
        return j(res, 200, {
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: '格式錯誤。', flags: 64 },
        });
      }
      const uid = mm[1];
      const from = Number(mm[2]);
      const to = Number(mm[3]);
      const r = tryMove(state, uid, from, to);
      if (!r.ok) {
        return j(res, 200, {
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: r.msg, flags: 64 },
        });
      }
      const { content: newContent, components: newComps } = rebuildMessage(
        state,
      );
      return j(res, 200, {
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: newContent,
          components: newComps,
          allowed_mentions: { parse: [] },
        },
      });
    }

    // 其它元件
    return j(res, 200, {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: '未支援的操作。', flags: 64 },
    });
  }

  // 其它互動
  return j(res, 200, {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: '未支援的互動。', flags: 64 },
  });
}

// ===== Handler (with verify-only gate) =====
export default async function handler(req, res) {
  // HEAD：必回 200
  if (req.method === 'HEAD') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // 簽章驗證
  const sig = req.headers['x-signature-ed25519'];
  const ts = req.headers['x-signature-timestamp'];
  if (!sig || !ts) return res.status(401).send('missing signature headers');

  const raw = await readRawBody(req);
  let ok = false;
  try {
    ok = verifyKey(raw, sig, ts, process.env.PUBLIC_KEY);
  } catch {
    ok = false;
  }
  if (!ok) return res.status(401).send('invalid request signature');

  const interaction = JSON.parse(raw);

  // 驗證模式（預設開啟）
  if (isVerifyOnly(req)) {
    if (interaction.type === InteractionType.PING) {
      return j(res, 200, { type: InteractionResponseType.PONG });
    }
    return j(res, 200, {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'OK（verify-only 模式）', flags: 64 },
    });
  }

  // 完整功能
  try {
    return await fullAppHandler(interaction, req, res);
  } catch (e) {
    console.error('full handler error', e);
    return j(res, 200, {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: 'Internal error', flags: 64 },
    });
  }
}
