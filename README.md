# Provider-Style Web Channel

这个项目现在是一个面向 OpenClaw 的 `customchat` 自定义 channel 门户，目标形态接近 Slack / Telegram：

- 浏览器不直接连接 OpenClaw Gateway
- app 不直接订阅 Gateway 事件
- OpenClaw 侧安装 `customchat` 插件，插件作为 channel adapter
- `plugin -> Gateway` 走常驻 WebSocket
- `plugin -> app` 走常驻 WebSocket
- `app -> browser` 走 SSE

## 测试

> 🧪 测试覆盖说明（各模块覆盖的功能、用例数、Mock 策略、测试代码链接）见 [docs/testing.md](docs/testing.md)。

```bash
npm test            # 运行全部测试
npm run test:watch  # 监听模式
```

## 当前数据链路

一条消息从输入到显示，完整路径是：

1. 浏览器 -> app  
   `POST /api/customchat/webhook`
2. app -> OpenClaw 插件 ingress  
   `POST /customchat/inbound`
3. OpenClaw 插件 -> Gateway  
   `chat.send`
4. Gateway -> OpenClaw 插件  
   常驻 WebSocket 推送 `chat` / `agent` 事件
5. OpenClaw 插件 -> app  
   常驻 WebSocket 推送 `delta / final / runtimeSteps / attachments`
6. app -> 浏览器  
   `SSE /api/panels/:panelId/stream`

## 群组功能

群组模式下，每个群角色都是一个独立执行单元：

- 每个群角色绑定一个独立 agent
- 每个群角色拥有独立 provider session
- 群消息通过显式 `@角色` 或默认 leader 路由到目标角色
- 角色忙碌时，新消息进入该角色自己的等待队列
- 每个群组维护任务状态：`空闲 / 进行中 / 已完成`
- 群任务完成状态由 leader 在回复中显式输出 `[TASK_COMPLETED]` 控制
- 群任务 3 分钟无新消息且仍未完成时，系统会自动提醒 leader 催办并总结

### 群组消息流程图

```mermaid
flowchart TD
    A["用户/角色发消息"] --> B["群状态切到 in_progress"]
    B --> C["群路由解析 @"]
    C --> D["定位目标角色"]
    D --> E{"角色是否空闲?"}
    E -->|是| F["直接 dispatch"]
    F --> G["记录 busy(runId)"]
    E -->|否| H["消息进入该角色等待队列"]

    I["角色回流 final/error/aborted"] --> J{"runId 是否匹配当前 active run?"}
    J -->|匹配| K["释放 busy, 切回 idle"]
    K --> L{"leader 是否输出 [TASK_COMPLETED]?"}
    L -->|是| M["群状态切到 completed"]
    L -->|否| N["保持当前群状态"]
    M --> O["刷该角色等待队列"]
    N --> O
    J -->|不匹配| P["忽略旧事件, 不释放执行权"]

    Q["群里所有角色 idle 且任务仍 in_progress"] --> R{"距离最后一条群消息是否 >= 3 分钟?"}
    R -->|是| S["系统提醒 leader 催促其他成员汇报进度"]
    S --> T["leader 汇总后继续分派, 或输出 [TASK_COMPLETED]"]
```

### 群组超时恢复机制

为避免某个群角色异常卡住导致整个协作链停摆，群组路由增加了 watchdog：

- 单个全局 `setInterval`
- 每 30 秒扫描一次当前 `busy` 的群角色
- 满 5 分钟仍未 idle：
  - 查询 provider session/run 状态
  - 若远端已终态或 session 已丢失，则本地纠偏为 idle 并继续刷队列
- 满 10 分钟仍未 idle：
  - 主动向 provider 发起 abort

更详细的设计见 [docs/group-technical-design.md](docs/group-technical-design.md)。

当前使用内置默认值：

- watchdog 扫描周期：`30000`
- 超过多久开始查 session：`300000`
- 超过多久主动 abort：`600000`

## 整体架构

> 📖 完整的项目全景分析（语言、框架、模块划分、数据模型、关键文件速查等）见 [docs/project-overview.md](docs/project-overview.md)。

这套系统可以拆成 4 个角色：

1. 网页前端
2. app 服务端
3. OpenClaw `customchat` channel 插件
4. OpenClaw Gateway

它们的职责分别是：

### 1. 网页前端

- 负责聊天 UI、角色列表、消息展示、附件展示
- 不直接连接 OpenClaw Gateway
- 不直接和 `customchat` 插件通信
- 只和 app 服务端通信

### 2. app 服务端

- 负责登录态、面板数据、消息存储、SSE 推送
- 负责把用户输入转发给 OpenClaw `customchat` 插件 ingress
- 负责接收插件回推的文本增量、runtime steps、附件事件
- 负责把这些事件广播给浏览器

### 3. OpenClaw `customchat` 插件

- 负责把 app 的用户消息接入 OpenClaw chat-plane
- 负责维护和 Gateway 的常驻 WebSocket 订阅
- 负责按 `sessionKey / runId` 跟踪多会话、多运行中的事件
- 负责把 Gateway 回流事件转发到 app
- 这是整个系统里的 channel adapter

### 4. OpenClaw Gateway

- 负责真正的 session、run、agent、tool 调用、模型推理
- 负责把 `chat` / `agent` 事件推给 `customchat` 插件
- 负责处理 `chat.send`、`chat.abort` 等 RPC

## 通信方式总表

不同层之间不是同一种协议，当前使用方式如下：

| 链路 | 方向 | 协议 | 用途 |
|---|---|---|---|
| 网页 -> app | 浏览器 -> Next.js | HTTP | 发送用户消息、登录、读取页面数据 |
| app -> 网页 | Next.js -> 浏览器 | SSE | 推送消息增量、终态、runtime steps |
| app -> 插件 | app -> `customchat` ingress | HTTP | 把用户消息送进 OpenClaw channel |
| 插件 -> app | `customchat` -> app bridge | WebSocket | 推送 `delta / final / attachments / runtimeSteps` |
| 插件 -> Gateway | `customchat` -> Gateway | RPC + WebSocket | `chat.send / chat.abort`，以及实时订阅 `chat/agent` 事件 |
| Gateway -> 插件 | Gateway -> `customchat` | WebSocket | 推送 session / run / tool / assistant 事件 |

## 一次完整对话时的交互顺序

### 1. 用户发消息

- 浏览器调用 app 的 `POST /api/customchat/webhook`
- app 先本地写入 user message
- app 再把这条消息 `POST` 到 OpenClaw 插件 ingress：`/customchat/inbound`

### 2. 插件启动 run

- `customchat` 插件收到 ingress 后
- 根据 panel / agent 计算目标 `sessionKey`
- 调 Gateway 的 `chat.send`
- 把这次运行注册到插件内部的 tracked run 表里

### 3. Gateway 实时产出事件

- Gateway 把 assistant 文本增量、toolCall、toolResult 等事件
- 通过插件维护的常驻 WebSocket 推给 `customchat`
- 插件按 `runId / sessionKey` 把事件归到对应 panel

### 4. 插件把事件送回 app

- 插件通过到 app 的常驻 WebSocket bridge
- 持续推送：
  - `delta`
  - `final`
  - `attachments`
  - `runtimeSteps`

### 5. app 把事件推给浏览器

- app 收到 bridge 事件后写入本地 store
- 同时通过 `SSE /api/panels/:panelId/stream`
- 把最新消息状态推给当前打开该对话的浏览器

## 为什么是这种架构

这套设计是为了尽量接近 Slack / Telegram 这种 provider-style channel：

- 浏览器不是 OpenClaw 的直接客户端
- app 不是 Gateway 的直接事件消费者
- OpenClaw 通过 channel 插件持有“这条消息属于哪个 session / run / target”的路由事实
- app 更像一个被动门户，只负责门户 UI 和本地存储

## 当前可靠性策略

现在这套实时链路不是只靠一条 WebSocket“盲信”，而是三层保障：

1. 插件到 Gateway 使用常驻 WebSocket
   避免“先启动 run，后订阅事件”造成的早期事件丢失
2. 插件对活跃 run 做 `sessionKey / runId` 跟踪
   多个 session / 多个 run 共享一条 Gateway WS，但内部会正确分发
3. 插件在必要时会用 `chat.history` 做回补
   用于处理重连、短暂断连、或者某些事件错过的场景

## 多 session / 多 run 的工作方式

当前不是“一条 session 一个 WebSocket”。

而是：

- `customchat` 插件维护一条常驻 Gateway WS
- 所有 session / run 共用这条 WS
- 插件内部维护路由表：
  - `runId -> sessionKey`
  - `sessionKey -> panelId`
  - `panelId -> app target`

所以：

- 可以同时有多个角色对话
- 可以同时有多个 session 在运行
- 不需要为每个会话额外建立一个独立 Gateway WS

## 终止推理的链路

点击“停止推理”时，当前路径是：

1. 浏览器 -> app  
   `POST /api/panels/:panelId/abort`
2. app -> OpenClaw 插件  
   请求 channel provider 执行 abort
3. 插件 -> Gateway  
   调 `chat.abort`
4. Gateway -> 插件  
   返回 run/session 终态
5. 插件 -> app -> 浏览器  
   更新当前消息状态为 `aborted`

## 部署模式

当前 README 以这套部署方式为准：

- OpenClaw 运行在宿主机
- app 运行在同一台机器上的 Docker 容器
- Docker 使用 `network_mode: host`

在这个模式下：

- app 容器访问 Gateway：`http://127.0.0.1:18789`
- OpenClaw 插件回推 app：`ws://127.0.0.1:3001/api/customchat/socket`

## 配置总览

主配置分 2 处：

1. app Docker 环境变量
2. OpenClaw `~/.openclaw/openclaw.json`

### 哪些值必须保持一致

以下值是成对使用的，必须一致：

- `CUSTOMCHAT_AUTH_TOKEN` / `channels.customchat.authToken`
  customchat 的统一鉴权 token，同时用于 app -> 插件 HTTP 和 插件 -> app bridge
- `CUSTOMCHAT_BRIDGE_PORT` / `channels.customchat.bridgePort`
  只有你不使用默认 `3001` 时才需要同时配置，而且两边必须一致

## 一、app Docker 环境变量

app 容器使用这些环境变量。推荐直接写在项目根目录的 `.env` 里，然后配合 [docker-compose.yml](./docker-compose.yml) 启动。

### 必需变量

| 变量 | 必需 | 示例 | 作用 |
|---|---|---|---|
| `APP_SESSION_SECRET` | 是 | `replace-with-a-long-random-secret` | 登录态 JWT 签名密钥 |
| `APP_ADMIN_EMAIL` | 是 | `admin@example.com` | 初始管理员邮箱 |
| `APP_ADMIN_PASSWORD` | 是 | `ChangeMe123!` | 初始管理员密码 |
| `CUSTOMCHAT_PROVIDER_BASE_URL` | 否 | `http://127.0.0.1:18789` | app 访问 OpenClaw 插件 ingress 的地址；同机默认部署通常不用改 |
| `CUSTOMCHAT_AUTH_TOKEN` | 是 | `change-me-customchat-token` | customchat 统一鉴权 token，同时用于 app -> 插件 HTTP 和 插件 -> app bridge |

### 推荐变量

| 变量 | 必需 | 默认值 | 作用 |
|---|---|---|---|
| `APP_BASE_URL` | 推荐 | `http://127.0.0.1:3000` | app 自己的外部访问地址，用于 cookie secure 判断等 |
| `APP_ADMIN_NAME` | 否 | `Channel Admin` | 初始管理员显示名 |
| `APP_AGENT_CATALOG` | 否 | `[{"id":"main","name":"Main"}]` | provider 拉取失败时的 agent fallback 列表 |
| `CUSTOMCHAT_BRIDGE_PORT` | 否 | `3001` | app bridge WebSocket 监听端口；只有端口冲突时才需要改 |

### 一般不用改的变量

| 变量 | 默认值 | 作用 |
|---|---|---|
| `APP_UID` | `1000` | Docker 容器运行用户 UID |
| `APP_GID` | `1000` | Docker 容器运行用户 GID |

### 示例 `.env`

```bash
APP_BASE_URL=http://127.0.0.1:3000
APP_SESSION_SECRET=replace-with-a-long-random-secret
APP_ADMIN_EMAIL=admin@example.com
APP_ADMIN_PASSWORD=ChangeMe123!
APP_ADMIN_NAME=Channel Admin

CUSTOMCHAT_PROVIDER_BASE_URL=http://127.0.0.1:18789
CUSTOMCHAT_AUTH_TOKEN=change-me-customchat-token
CUSTOMCHAT_BRIDGE_PORT=3001

APP_AGENT_CATALOG=[{"id":"main","name":"Main"},{"id":"coding","name":"coding","emoji":"🧑‍💻"},{"id":"ui-designer","name":"UI Designer","emoji":"🎨"},{"id":"lucy","name":"Lucy","emoji":"📚"}]
```

## 二、OpenClaw `openclaw.json`

OpenClaw 的 channel 主配置写在：

`~/.openclaw/openclaw.json`

最关键的是 `channels.customchat`：

```json
{
  "channels": {
    "customchat": {
      "authToken": "change-me-customchat-token",
      "bridgePort": 3001,
      "debug": false
    }
  }
}
```

### 字段作用

| 字段 | 必需 | 作用 |
|---|---|---|
| `channels.customchat.authToken` | 是 | customchat 统一鉴权 token；app 侧 `CUSTOMCHAT_AUTH_TOKEN` 必须与之保持一致 |
| `channels.customchat.bridgePort` | 否 | OpenClaw 插件回连 app bridge 的端口；默认 `3001` |
| `channels.customchat.debug` | 否 | 是否开启插件 debug 日志 |

### 优先级说明

对于 `authToken` 和 `bridgePort`：

1. 插件先读 `openclaw.json` 的 `channels.customchat`
2. app 读取自己的 `.env`
3. 其中只有 `bridgePort` 会在两边各留一份，这是因为 app 无法读取 `openclaw.json`

建议做法：

- 把 `authToken` 固定写在 `openclaw.json`
- 只有 bridge 端口冲突时，才同时改 `.env` 里的 `CUSTOMCHAT_BRIDGE_PORT` 和 `openclaw.json` 里的 `channels.customchat.bridgePort`

## 三、哪些变量在哪里生效

这一段最容易混：

### app -> OpenClaw

由 app 使用：

- `CUSTOMCHAT_PROVIDER_BASE_URL`
- `CUSTOMCHAT_AUTH_TOKEN`

用途：

- `CUSTOMCHAT_PROVIDER_BASE_URL` 决定 app 去哪里访问 OpenClaw 插件 HTTP 接口
- `CUSTOMCHAT_AUTH_TOKEN` 用作 app -> 插件 HTTP Bearer 鉴权

### OpenClaw -> app

由 OpenClaw 插件使用：

- `channels.customchat.authToken`
- `channels.customchat.bridgePort`
- `channels.customchat.debug`

用途：

- `authToken` 同时用于 app -> 插件 ingress 鉴权 和 插件 -> app bridge 鉴权
- `bridgePort` 用于插件 -> app bridge 回连
- `debug` 控制插件是否输出 debug 日志

### app bridge WebSocket

bridge host 和 path 现在是固定约定：

- host：`127.0.0.1`
- path：`/api/customchat/socket`

只有端口允许覆盖：

- app 侧：`CUSTOMCHAT_BRIDGE_PORT`
- 插件侧：`channels.customchat.bridgePort`

同机部署默认就是：

```text
ws://127.0.0.1:3001/api/customchat/socket
```

## 四、Docker 启动

当前 Compose 已经按“同机宿主机 + host 网络”写好了：

[docker-compose.yml](./docker-compose.yml)

启动：

```bash
docker compose up --build -d
```

查看日志：

```bash
docker compose logs -f web
```

## 五、OpenClaw 插件安装

在 OpenClaw 宿主机执行：

```bash
cd /home/user/program/ChatBot
openclaw plugins install --link ./plugins/customchat
```

安装后可以检查：

```bash
openclaw plugins list
```

确保 `customchat` 指向的是：

```text
/home/user/program/ChatBot/plugins/customchat
```

## 六、部署后自检

### 检查 app

```bash
curl -I http://127.0.0.1:3000/login
```

预期：`200 OK`

### 检查 app bridge

```bash
node - <<'NODE'
const ws = new WebSocket("ws://127.0.0.1:3001/api/customchat/socket?token=YOUR_CUSTOMCHAT_AUTH_TOKEN");
ws.addEventListener("open", () => console.log("OPEN"));
ws.addEventListener("message", (event) => {
  console.log(String(event.data));
  process.exit(0);
});
NODE
```

预期：

```json
{"type":"hello","role":"app","protocol":1}
```

### 检查 provider agents

```bash
curl -H "Authorization: Bearer YOUR_CUSTOMCHAT_AUTH_TOKEN" \
  http://127.0.0.1:18789/customchat/agents
```

如果这里能返回真实 agent 列表，前端的 agent 名字 / emoji / avatar 才会显示真实值。

### 检查 app 看到的 agents

先登录，再请求：

```bash
curl -b /tmp/chatbot-cookies.txt http://127.0.0.1:3000/api/agents
```

预期：

- 返回真实 agent，而不是只剩 `main`
- `avatarUrl` 形如 `/api/agents/<agentId>/avatar`

## 七、问题排查

> 🔍 完整的问题排查 SOP（登录、消息、流式推送、附件、中止推理等 10 类故障场景的排查步骤、调试日志开关配置）见 [docs/troubleshooting.md](docs/troubleshooting.md)。

## 八、常见问题

### 1. 页面里只看到 `main`

通常是 app 没拿到 provider 的 `/customchat/agents`，于是回退到了 `APP_AGENT_CATALOG`。

优先检查：

- app 的 `CUSTOMCHAT_AUTH_TOKEN` 是否和 `openclaw.json` 里的 `channels.customchat.authToken` 一致
- `http://127.0.0.1:18789/customchat/agents` 是否能返回真实 agent

### 2. 有 emoji 没头像，或者头像不显示

优先检查：

- `http://127.0.0.1:18789/customchat/agent-avatar?agentId=<id>` 是否能返回图片
- `http://127.0.0.1:3000/api/agents/<id>/avatar` 在登录后是否返回 `200`

### 3. bridge 端口要不要配

推荐：

- 不改端口时，什么都不用配，默认就是 `3001`
- 只有端口冲突时，才同时改：
  - app `.env`：`CUSTOMCHAT_BRIDGE_PORT`
  - OpenClaw `openclaw.json`：`channels.customchat.bridgePort`

这样虽然 `bridgePort` 不可避免地分成两处，但职责仍然清楚：app 只读 `.env`，插件只读 `openclaw.json`。

### 4. 调试日志该配在哪里

推荐直接写到 `~/.openclaw/openclaw.json`：

```json
{
  "channels": {
    "customchat": {
      "debug": true
    }
  }
}
```

这样就不需要再额外维护一份 `systemd` 环境变量配置。

### 5. 为什么 app 是 `host` 网络

因为 Gateway 限制在 `127.0.0.1`，容器如果用 bridge 网络，宿主机看到的来源不会是 `127.0.0.1`。  
`network_mode: host` 能保证 app 容器访问 `127.0.0.1:18789` 时，对 OpenClaw 来说就是真正的本机回环访问。

## 九、当前实现备注

- `plugin -> Gateway`：常驻 WS
- `plugin -> app`：常驻 WS
- `app -> browser`：SSE
- `lifecycle phase=end` 作为气泡 finalize 的兜底信号（见十二节）
- 可靠性依赖：
  - WS 实时事件
  - `chat.history` 回补
  - 重连后活跃 run 恢复

## 十、工具执行信息（Tool Events）

### 1. 从 Gateway 获取工具信息

Gateway 的 `event:agent` 推送有多种 stream 类型：

| stream | 推送方式 | 内容 |
|---|---|---|
| `lifecycle` | 广播给所有 WS 客户端 | `phase: start/end`，**run 级别**的生命周期信号 |
| `assistant` | 广播给所有 WS 客户端 | 模型文本输出的增量 |
| `tool` | **仅推送给声明了 `caps: [“tool-events”]` 的客户端** | 工具调用的实时事件 |

**lifecycle 与 event:chat 的关系**：

- `lifecycle phase=start`：agent run 启动（此时气泡可以出现）
- `lifecycle phase=end`：整个 agent run 真正结束，是 run 级别的权威结束信号
- `event:chat state=final`：模型文本输出结束，是消息级别的结束信号
- 实测时序：`lifecycle phase=end` 比 `event:chat state=final` 早约 3ms 到达
- **一个 Gateway runId 的生命周期内只会出现一次 `event:chat state=final`**，不存在中间 final
- `lifecycle phase=end` 同时作为**兜底 finalize 信号**：若 run 结束时 bubble 仍未收到 `state=final`（如 agent 只调用工具不输出文本），插件收到 `lifecycle phase=end` 后主动 finalize 该 bubble

**关键发现：`stream=tool` 不是广播，而是按需注册的。** 要收到 tool 事件，插件必须满足：

1. WebSocket connect 帧中声明 `caps: [“tool-events”]`
2. Gateway 在 `chat.send` 的 `onAgentRunStart` 回调中自动注册该 connId
3. 然后通过 `broadcastToConnIds` 只推送给已注册的客户端

插件的 connect 参数：

```typescript
params: {
  minProtocol: 3,
  maxProtocol: 3,
  client: { id: clientId, displayName: “Custom Chat Plugin”, ... },
  role: “operator”,
  scopes: [“operator.admin”, “operator.read”, “operator.write”],
  caps: [“tool-events”],  // 必须声明，否则收不到 stream=tool
  device: { ... },
}
```

### 2. Tool 事件的两个阶段

每个工具调用产生两个事件：

**`phase: “start”`** — 工具开始执行：

```json
{
  “phase”: “start”,
  “name”: “web_search”,
  “toolCallId”: “rz71ubrp”,
  “args”: { “query”: “武汉天气” }
}
```

**`phase: “result”`** — 工具执行完成：

```json
{
  “phase”: “result”,
  “name”: “web_search”,
  “toolCallId”: “rz71ubrp”,
  “meta”: “for \”武汉天气\””,
  “isError”: false,
  “result”: { “content”: [{ “type”: “text”, “text”: “...” }] }
}
```

### 3. 获取完整工具输出（Tool Output）

默认情况下，Gateway 会**裁剪** tool event 中的 `result` 和 `partialResult` 字段。要获取完整的工具输出，需要设置 `verboseDefault`。

**检查优先级**（`resolveToolVerboseLevel`）：

1. 当前 run 的 `verboseLevel`
2. session entry 的 `verboseLevel`
3. `agents.defaults.verboseDefault`（全局配置）
4. 默认值 `”off”`

**级别说明**：

| 级别 | `result` 字段 | 说明 |
|---|---|---|
| `”off”` | 被删除 | 默认，只保留 `phase`/`name`/`toolCallId` 等元数据 |
| `”full”` | 完整保留 | 包含工具的完整输出内容 |

**配置方法**：在 `~/.openclaw/openclaw.json` 的 `agents.defaults` 中添加：

```json
{
  “agents”: {
    “defaults”: {
      “verboseDefault”: “full”
    }
  }
}
```

> 注意：`result` 的数据结构是 `{ content: [{ type: “text”, text: “...” }] }`，不是纯字符串。

### 4. 插件处理流程

插件收到 `stream=tool` 事件后：

1. **`phase=start`**：缓存 `args`（按 `toolCallId`），构建 runtimeStep（status=running），通过 `sendPortalDelivery` 以 delta 状态发送到 app
2. **`phase=result`**：从缓存取回 args，提取 `result.content[0].text` 作为详情，更新 runtimeStep（status=done），再次发送到 app

所有 tool 事件使用**主消息的 runId**，runtimeSteps 附加在同一条消息上，不创建独立气泡。

**`message` tool 的特殊性**：`message` tool 调用时也会产生 runtimeStep 并挂载到主消息上。若主消息**仅**含 `message` tool runtimeStep 且文本为空，会被前端的 `isBridgeDeliveryMessage` 过滤器隐藏（见十二节）；若主消息还包含其他工具步骤（如 exec、search），则正常显示。真正的内容通过 inbound 投递为独立气泡显示。

## 十二、消息生命周期与气泡判定

### 1. 一条消息的完整事件时序

一个 agent run 包含三条独立的事件流：

```
stream=lifecycle        stream=tool                event:chat
      │                      │                          │
      ▼                      │                          │
phase=start                  │                          │
（run 启动）                  │                          │
      │                      ▼                          │
      │             phase=start ──► runtimeStep         │
      │             (status=running)                     │
      │                      │                     state=delta ──► 文本流式推送
      │             phase=result ──► runtimeStep         │
      │             (status=done)                        │
      │                      │                     state=delta ──► 文本持续更新
      ▼                      │                          │
phase=end ◄──────────────────┴──────────────────► state=final
（run 结束，权威信号）                             （消息完成，draft=false）
```

**关键规则**：

- `stream=tool` 事件**不影响**消息的 `state`（delta/final）
- 消息是否完成**只看** `event:chat` 的 `state=final`
- **一个 Gateway runId 只会出现一次 `state=final`**，无中间 final
- `lifecycle phase=end` 比 `event:chat state=final` 略早（实测约 3ms），是气泡 finalize 的兜底信号
- 若 `lifecycle phase=end` 到达时 `terminalState` 未设置（未收到 `state=final`），插件主动 finalize 该 bubble
- 两个 agent 工具调用可以**并发**执行（两个 phase=start 同时发出）
- 整个 run（包含所有工具循环）共享同一个 Gateway runId、同一个 lifecycle

### 2. 气泡判定逻辑

**一个气泡 = 一条 message record = 一个 runId**

| 操作 | 结果 |
|---|---|
| 相同 runId 的 delivery 到达 | `upsertAssistantMessage` 更新已有记录 → 同一个气泡 |
| 不同 runId 的 delivery 到达 | 创建新 message record → 新气泡 |

**存储结构**：

```typescript
message = {
  runId: “abc123”,              // 气泡唯一标识
  text: “大理现在的天气...”,      // 最终文本
  runtimeSteps: [               // 工具执行信息（嵌入在消息内）
    {
      id: “toolCallId”,
      stream: “tool”,
      kind: “search”,
      title: “Search”,
      description: “大理天气”,
      detail: “{ ... 搜索结果 ... }”,
      status: “done”
    }
  ],
  state: “final”,
  draft: false,
}
```

**前端渲染**（`message-bubble.tsx`）：

1. 检查 `runtimeSteps.length > 0`
2. 有 → 在文本上方渲染可展开的 `<details>` 工具卡片
3. 渲染 `message.text`（文本部分）
4. 工具卡片和文本都在同一个气泡容器内

### 3. isBridgeDeliveryMessage 过滤器

`message-list.tsx` 在渲染前过滤掉”纯桥接空壳”消息：

```typescript
// message-list.tsx
const list = messages.filter((message) => !isBridgeDeliveryMessage(message));

// chat-helpers.tsx
function isBridgeDeliveryMessage(message): boolean {
  if (message.role !== “assistant”) return false;
  if (message.attachments.length > 0) return false;  // 有附件 → 显示
  if (message.runtimeSteps.length > 0) return false; // 有任何工具步骤 → 显示
  const trimmed = message.text.trim();
  return trimmed === “” || /^no$/i.test(trimmed);     // 空文本 → 过滤
}
```

**触发条件**：assistant 消息 + 无 runtimeSteps + 无附件 + 文本为空（或为 “no”）

**设计意图**：当 agent 通过 `message` tool 投递内容，且主 run 既无文本、无工具信息、无附件时，该气泡是纯空壳，过滤掉。一旦有任何工具步骤（exec、search、message 等），气泡本身就有展示价值，正常显示。

**`message` tool 气泡结构示例**（agent 仅发消息，无其他工具）：

```
┌─────────────────────────────┐
│  （无文本，无步骤）           │  ← 主 run 空壳，被过滤隐藏
└─────────────────────────────┘

┌─────────────────────────────┐
│  1                          │  ← customchat:UUID（实际显示）
└─────────────────────────────┘

┌─────────────────────────────┐
│  2                          │  ← customchat:UUID（实际显示）
└─────────────────────────────┘
```

**含其他工具步骤时**（如 exec + message）：

```
┌─────────────────────────────┐
│  🛠 Exec: ls -F ...  ✓      │  ← runtimeStep（正常显示）
│  📨 Message (→ 图片)  ✓     │
│  （无文本）                  │
└─────────────────────────────┘

┌─────────────────────────────┐
│  这就是我的头像啦！🐶        │  ← customchat:UUID（图片独立气泡）
│  [图片]                     │
└─────────────────────────────┘
```

### 4. 时序示例

以”搜索武汉天气”为例：

```
11:25:54  stream=lifecycle phase=start     → run 启动
11:25:56  stream=tool phase=start          → 气泡内显示 🔎 Search: 武汉天气 (Running)
11:26:00  stream=tool phase=result         → 工具卡片更新为 (Completed)，可展开看详情
11:26:02  event:chat state=delta           → 文本开始流式出现在工具卡片下方
11:26:03  event:chat state=delta           → 文本持续更新
11:26:03  stream=lifecycle phase=end       → run 结束（权威信号）
11:26:03  event:chat state=final           → 消息完成，气泡固定（约晚 3ms）
```

### 4. Seq Guard

App 使用 `eventSeq` 防止乱序覆盖：

- 每次 delivery 带一个递增的 `seq`
- `upsertAssistantMessage` 检查：如果 `incoming seq < existing eventSeq`，丢弃
- 保证工具信息和文本更新不会被旧事件覆盖

### 5. normalizeChatEventRunId（前端 runId 对齐）

**设计意图**：browser 侧可能先收到一个 `customchat:UUID` draft 消息（插件生成的 ID），后续 Gateway 的真实 runId 到来时，应将该 draft 升级为真实 runId 对应的消息。

```typescript
// chat-helpers.tsx
function normalizeChatEventRunId(current, event, activeRunId) {
  // 只在 activeRunId 是 customchat:UUID（插件生成）时才做合并
  // 若 activeRunId 是真实 Gateway runId，incoming event 是独立投递，不能合并
  if (!activeRunId.startsWith("customchat:") || event.runId.startsWith("customchat:")) {
    return event;
  }
  const hasAliasDraft = current.some(m => m.runId === activeRunId && m.draft);
  if (!hasAliasDraft) return event;
  return { ...event, runId: activeRunId };
}
```

**关键约束**：只在 `activeRunId` 为 `customchat:UUID` 格式时才合并。若 activeRunId 是真实 Gateway runId（如 `h0sbzk3zg6q`），则 incoming event 是独立的 `message` tool delivery，不应合并进主气泡。

**Bug 场景（已修复）**：agent 用 `message` tool 发送图片时：
- tool-step delta 将 `h0sbzk3zg6q`（真实 Gateway runId）设为 activeRunId
- 图片的独立投递（`customchat:UUID`, `state=final`）到达浏览器
- 修复前：`normalizeChatEventRunId` 错误地将图片投递合并进 `h0sbzk3zg6q`，seq guard 因 `seq=0 < existing seq` 丢弃更新，图片不显示
- 修复后：检测到 activeRunId 不是 `customchat:UUID` → 跳过合并 → 图片作为独立气泡正常显示

### 6. 纯工具 run（无文本输出）时序

当 agent 只调用工具、不产生任何文本时（如 agent 检查文件后用 `message` tool 发送图片），**Gateway 不会发出任何 `event:chat`**：

```
lifecycle start   h0sbzk3zg6q
tool exec  start/result       → runtimeStep[exec] delta delivery
tool message start/result     → runtimeStep[message] delta delivery
                              → 同时触发 deliverMessage → 图片独立 delivery (customchat:UUID)
lifecycle end                 → lifecycle fallback 触发
  → flushTrackedRunDelta + emitTrackedRunState("final") → h0sbzk3zg6q final delivery (textLen=0)
```

`event:chat` 从未出现。lifecycle fallback 是这类 run 唯一的兜底 finalize 机制。

### 7. 气泡底部的 Session 信息

assistant 气泡底部会展示一行精简的 session 摘要，例如：

```text
Doudou 🐶 · 23:47:57 · gpt-5.2 · 19.2k/272k (7%)
```

若当前 session 的 compaction 次数大于 0，则会额外显示：

```text
... · cpt: 2
```

#### 展示规则

- 只展示在 assistant 气泡下，不展示在用户自己发送的消息下
- 只展示在同一角色连续回复分组的**最后一个**气泡下
- `cpt` 只有在 `compactions > 0` 时才显示；`0` 时隐藏
- 不展示 `sessionKey`

#### 数据获取链路

当前这行信息不是前端临时算出来的，而是在 assistant 消息终态后补查并写回消息记录：

1. assistant 消息进入终态（`final / aborted / error`）
2. app 在 `ingestCustomChatDelivery` 中调用 provider：
   `GET /customchat/status`
3. `customchat` 插件根据 `panelId / agentId / target / sessionKey` 定位真实 session
4. 插件优先读取 OpenClaw session store：
   `~/.openclaw/agents/<agentId>/sessions/sessions.json`
5. 用 sessionKey 取出对应记录，拼成一段 `statusText`
6. app 解析这段 `statusText`，提取：
   - `model`
   - `context used / max / percent`
   - `compactions`
7. 结果写入消息的 `sessionMeta`
8. SSE 把带 `sessionMeta` 的消息事件推给浏览器

因为 `sessionMeta` 已经入库，所以：

- 刷新页面后不会丢
- 旧消息会按当时入库的值显示
- 修改展示文案（如 `Compactions` -> `cpt`）不需要改存储结构

#### 为什么不用 `inspect` 直接展示

`/customchat/session` 的 inspect 结果主要用于群组 watchdog / 运行态核验（session 是否存在、是否终态等），不再用于底部 Context 展示。

底部这行 session 信息现在走的是独立的 `/customchat/status` 链路，避免把 runtime snapshot 中无关数字误识别成：

- Context
- Compactions

#### 当前使用的核心字段

session store 中当前实际会用到的字段包括：

- `model`
- `modelProvider`
- `totalTokens`
- `contextTokens`
- `compactionCount`
- `authProfileOverrideCompactionCount`（兜底）

插件会把它们组装成与 OpenClaw `/status` 风格接近的文本，再由 app 做解析和展示。

## 十三、文件/附件处理

### 1. 完整流程

```mermaid
flowchart TD
    A["Browser"] --> B["App Webhook<br/>(FormData multipart)"]
    B --> C["落盘到 storage/uploads/{uuid}"]
    C --> D["Base64 编码"]
    D --> E["POST /customchat/inbound"]
    E --> F["Plugin 解码"]
    F --> G["落盘到 ~/.openclaw/channels/customchat/{target}/{msgId}/"]
    G --> H["拼接文件路径到消息文本"]
    H --> I["chat.send"]
    I --> J["Gateway"]
    J --> K["Agent"]
```

### 2. 各层处理逻辑

**① 浏览器 → App（`/api/customchat/webhook`）**

- 文件通过 `multipart/form-data` 上传
- 同时用 `URL.createObjectURL()` 生成 blob URL 做乐观 UI 预览

**② App 落盘（`lib/store.ts` → `persistUploadedFile`）**

- 写入 `{cwd}/storage/uploads/{uuid}`（无扩展名）
- 元数据（文件名、MIME type、size、storagePath）存入 `app-data.json`

**③ App → Plugin（`lib/panel-message.ts` → `dispatchViaProvider`）**

- 文件内容 Base64 编码后放入 JSON payload
- POST 到 `/customchat/inbound`，字段：`{name, mimeType, content: "base64...", size}`

**④ Plugin 落盘（`materializeInboundAttachments`）**

- Base64 解码，写入 `~/.openclaw/channels/customchat/{target}/{msgId}/{uuid}-{filename}`
- 文本类文件额外提取前 4000 字符作为 `extractedText`
- 同目录写一份 `manifest.json`

**⑤ Plugin → Gateway → Agent（`buildInboundAgentMessage`）**

文件以**本地路径**嵌入消息文本，agent 收到的是纯文本：

```
用户消息内容

[customchat attachments]
- image.png (image/png, 204800 bytes)

[OpenClaw local files]
- image.png: /home/user/.openclaw/channels/customchat/direct:xxx/msgid/uuid-image.png
- manifest.json: /home/user/.openclaw/channels/customchat/direct:xxx/msgid/manifest.json

Use these exact filesystem paths when you need to read, unzip, or process the uploaded files.

[Extracted text]
## File: document.txt
（文本文件的前 4000 字符）
```

Agent 通过文件系统工具（`read_file`、`bash` 等）直接读取这些路径，**不是 base64，不是 URL，是本地路径**。

### 3. 存储位置汇总

| 层级 | 路径 | 格式 | 说明 |
|---|---|---|---|
| App 上传 | `{cwd}/storage/uploads/{uuid}` | 二进制，无扩展名 | 用户上传的文件 |
| App 下载 | `{cwd}/storage/downloads/{uuid}` | 二进制，无扩展名 | agent 发回的文件 |
| Plugin/Channel | `~/.openclaw/channels/customchat/{target}/{msgId}/{uuid}-{name}` | 二进制，保留扩展名 | 消息到达插件时写入 |

### 4. 文件清理

**App 侧**：`deletePanel`、`clearPanelMessages`、`deletePanelMessage` 均会调用 `deleteStoredFiles` → `fs.unlink(storagePath)`，随对话/消息删除一同清理磁盘文件。

**Plugin/Channel 侧**：**无清理逻辑**。App 删除对话时不通知插件，`~/.openclaw/channels/customchat/` 下的文件永久堆积，需手动清理。这是一个已知的磁盘泄漏点。
