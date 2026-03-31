# Architecture

当前项目使用 Slack-style 自定义 channel：

```mermaid
flowchart LR
    B["User Browser"] <-->|"HTTPS + SSE"| W["Web Portal App"]
    W -->|"POST /customchat/inbound"| P["OpenClaw customchat plugin"]
    P -->|"openclaw agent --channel customchat --to channel:&lt;panelId&gt;"| O["OpenClaw"]
    O -->|"outbound customchat message"| P
    P -->|"POST /api/customchat/deliver"| W
    W -->|"Persist panels / messages / files"| S["Local Storage"]
```

## Key Points

- app 不直接持有 Gateway WS
- 插件才是 OpenClaw 里的 channel adapter
- panel 被映射成 `channel:<panelId>`
- app 负责界面和持久化，插件负责 OpenClaw ingress / outbound
