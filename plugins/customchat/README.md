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
      "authToken": "same-value-as-app-CUSTOMCHAT_AUTH_TOKEN",
      "bridgePort": 3001
    }
  }
}
```

## 环境变量

说明：

- `authToken`、`bridgePort` 可以直接写在 `~/.openclaw/openclaw.json`
- 插件现在不再使用 `baseUrl`
- `bridgePort` 默认就是 `3001`，只有你改了 app 侧 bridge 端口时才需要配置

可选：

```bash
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

1. 校验 `channels.customchat.authToken`
2. 把附件落到 OpenClaw 主机本地
3. 调用 `openclaw agent --channel customchat --to channel:123 --deliver`

## 出站

agent 回复时，插件会把文本和附件通过 WebSocket bridge 投递到：

```text
ws://127.0.0.1:3001/api/customchat/socket
```

门户收到后写入本地消息并通过 SSE 推回页面。
