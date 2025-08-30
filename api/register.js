// scripts/register-commands.mjs
import fetch from "node-fetch";

const APP_ID = process.env.APP_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;

// 你的 /cteam 定義（可以照需求調）
const commands = [{
  name: "cteam",
  description: "建立分組名單",
  type: 1,
  options: [
    { name: "caps", description: "各團名額，例: 5,3,2", type: 3, required: false },
    { name: "multi", description: "允許多團", type: 5, required: false },
    { name: "title", description: "標題", type: 3, required: false },
    { name: "defaults", description: "預設名單（每行: 團號: @A @B）", type: 3, required: false }
  ]
}];

async function upsertGlobal() {
  const url = `https://discord.com/api/v10/applications/${APP_ID}/commands`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands)
  });
  console.log("global", r.status, await r.text());
}

async function upsertGuild(guildId) {
  const url = `https://discord.com/api/v10/applications/${APP_ID}/guilds/${guildId}/commands`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands)
  });
  console.log(`guild ${guildId}`, r.status, await r.text());
}

// === 選一種：全域 或 多個 guild ===

// 1) 全域註冊（上線用）：
await upsertGlobal();

// 2) 或者，針對多個 guild 註冊（開發/測試用）：
// const GUILDS = ["123456789012345678", "987654321098765432"];
// for (const g of GUILDS) await upsertGuild(g);
