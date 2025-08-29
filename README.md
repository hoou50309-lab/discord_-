- 環境變數：PUBLIC_KEY（必填）、BOT_TOKEN（建議）
- Endpoint：https://<你的>.vercel.app/api/discord
- 邀請 Bot（scopes: bot, applications.commands）
- 註冊指令（替換 APP_ID/GUILD_ID/BOT_TOKEN）：
curl -X PUT "https://discord.com/api/v10/applications/APP_ID/guilds/GUILD_ID/commands" \
  -H "Authorization: Bot BOT_TOKEN" -H "Content-Type: application/json" \
  -d '[
    {"name":"cteam","description":"建立 N 團訊息","options":[
      {"type":3,"name":"caps","description":"名額，如 12,12,12","required":false},
      {"type":5,"name":"multi","description":"允許同人多團","required":false},
      {"type":3,"name":"title","description":"標題","required":false},
      {"type":3,"name":"defaults","description":"預設名單，如：1: <@ID> <@ID>","required":false}
    ]},
    {"name":"myteams","description":"查詢我在指定訊息的所屬團","options":[{"type":3,"name":"message_id","required":false}]},
    {"name":"leaveall","description":"安全離團指引","options":[{"type":3,"name":"message_id","required":false}]}
  ]'
