# CustomChat OpenClaw Channel Plugin

这个插件把当前 Web 门户接成一个 Slack-style 自定义 channel：

- 门户把用户消息 POST 到插件 ingress
- 插件按 `channel:<panelId>` 目标启动 OpenClaw turn
- OpenClaw 回复通过 `customchat` outbound 回送到门户

## 安装

```bash
openclaw plugins install ./plugins/customchat
```

或开发模式：

```bash
openclaw plugins install --link ./plugins/customchat
```

## OpenClaw 配置

```json
{
  "channels": {
    "customchat": {
      "baseUrl": "https://your-app.example.com",
      "sharedSecret": "same-value-as-CUSTOMCHAT_SHARED_SECRET",
      "providerToken": "same-value-as-app-CUSTOMCHAT_PROVIDER_TOKEN"
    }
  }
}
```

## 环境变量

```bash
CUSTOMCHAT_SHARED_SECRET=...
CUSTOMCHAT_BASE_URL=https://your-app.example.com
```

说明：

- `baseUrl`、`sharedSecret`、`providerToken` 现在都可以直接写在 `~/.openclaw/openclaw.json`
- 这里的环境变量只作为 fallback
- `CUSTOMCHAT_PROVIDER_TOKEN` 只有在你不想把它写进 `openclaw.json` 时才需要保留

可选：

```bash
CUSTOMCHAT_PROVIDER_INGRESS_PATH=/customchat/inbound
OPENCLAW_CUSTOMCHAT_STORAGE_ROOT=/home/you/.openclaw/channels/customchat
CUSTOMCHAT_OPENCLAW_BIN=openclaw
```

## 目标格式

插件内部按 Slack-style `channel:<channelId>` 路由。

对当前门户来说，`channelId` 就是页面里的 `panelId`。

## 入站

门户向插件发送：

```json
{
  "panelId": "123",
  "agentId": "main",
  "target": "channel:123",
  "messageId": "uuid",
  "text": "hello",
  "attachments": []
}
```

插件会：

1. 校验 `channels.customchat.providerToken`（或 fallback `CUSTOMCHAT_PROVIDER_TOKEN`）
2. 把附件落到 OpenClaw 主机本地
3. 调用 `openclaw agent --channel customchat --to channel:123 --deliver`

## 出站

agent 回复时，插件会把文本和附件 POST 到：

```text
/api/customchat/deliver
```

门户收到后写入本地消息并通过 SSE 推回页面。
