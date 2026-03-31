# 群组消息路由方案（v4 — 纯路由 + 消息队列）

## 0. 设计原则

**App 只做两件事：路由 + 排队。** 不做编排、不管状态。

- **路由**：看到消息末尾有 @谁 → 转发给谁
- **排队**：目标角色正在推理 → 消息入队，推理完成后合并发送

所有编排决策（串行/并行、上下文传递、任务拆分）由角色自身通过 @ 指令驱动。

## 1. 消息协议

### 1.1 角色入群时注入的提示词

每个角色**首次被 dispatch 时**，消息头部注入群组上下文。Leader 和普通成员的提示词不同。

**普通成员提示词：**

```
[群组信息]
你正在一个群组中协作，你的角色名是「{当前角色名}」。
群组内的其他成员：
- {角色名1}
- {角色名2}（组长）
- {角色名3}

[消息规则]
1. 你收到的每条消息会标明来源：「用户」或「某个角色名」。
2. 如果你需要其他成员协助，请在回复的末尾另起一行，写上 @角色名。
3. 你的回复需要转交给某人时，也请在末尾写 @角色名。
4. 如果你的回复是最终结果、不需要转发给任何人，则不要在末尾写 @。
5. 完成其他成员交给你的任务后，务必在末尾 @对方，否则对方无法收到你的回复。
6. 你只能看到发给你的消息，无法直接看到其他成员之间的对话。

[回复格式示例]
这里是你的回复正文。

@角色名
```

**Leader 提示词：**

```
[群组信息]
你正在一个群组中协作，你的角色名是「{Leader角色名}」，你是本群组的组长。
群组内的其他成员：
- {角色名1}
- {角色名2}
- {角色名3}

[消息规则]
1. 你收到的每条消息会标明来源：「用户」或「某个角色名」。
2. 如果你需要其他成员协助，请在回复的末尾另起一行，写上 @角色名。
3. 你的回复需要转交给某人时，也请在末尾写 @角色名。
4. 如果你的回复是最终结果、不需要转发给任何人，则不要在末尾写 @。
5. 完成其他成员交给你的任务后，务必在末尾 @对方，否则对方无法收到你的回复。
6. 你只能看到发给你的消息，无法直接看到其他成员之间的对话。

[组长职责]
作为组长，当你收到来源不明或未指定接收人的消息时，你需要：
1. 根据消息内容和上下文判断这条消息的意图。
2. 如果需要某个成员处理，在你的回复末尾 @该成员。
3. 如果消息是某个成员的任务完成汇报，理解内容后决定下一步行动。
4. 如果不需要进一步操作，正常回复即可，不要在末尾 @任何人。

[回复格式示例]
这里是你的回复正文。

@角色名
```

### 1.2 App 发给角色的消息格式

**来自用户：**

```
[来自 用户]:
帮我做一个市场调研报告
```

**来自其他角色：**

```
[来自 PM]:
分析师负责收集数据，撰稿人负责准备模板。
```

**多条排队消息合并发送（目标角色忙时累积的）：**

```
[来自 分析师]:
Q1=500万 Q2=600万 Q3=700万。

[来自 撰稿人]:
报告模板已准备好。
```

### 1.3 角色回复格式

正文正常输出，末尾 @ 表示转发目标：

```
方案如下：
1. 第一步...
2. 第二步...

@撰稿人
```

多个目标：

```
我来安排分工。
分析师负责收集数据，撰稿人负责准备模板。

@分析师 @撰稿人
```

**末尾无 @ = 兜底转发给 Leader。**（详见 2.1 路由规则）

### 1.4 为什么 @ 放末尾

- **解析可靠**：只查最后几行，不会误匹配正文
- **不干扰正文**：角色在正文中提到其他角色名不会被误解析
- **前端展示统一**：末尾 @ 行从正文中剥离，在气泡右下角显示被 @ 角色的头像/emoji

## 2. 路由核心逻辑

### 2.1 路由规则

```
当 App 收到任何消息（用户发的 / 角色回复的）:
  1. 存入群组 panel（前端可见）
  2. 解析末尾 @mention
  3. if 有 @mention:
       对每个被 @ 的角色:
         角色空闲 → 立即转发
         角色正在推理 → 放入该角色的等待队列
  4. if 无 @mention 且消息来自角色（非用户）:
       → 兜底转发给 Leader
       （Leader 空闲则立即发送，忙则入队）
  5. if 无 @mention 且消息来自用户:
       → 提示用户"请 @ 一个角色"（不转发）
```

```
当某角色推理完成（state=final）:
  1. 存入群组 panel + SSE 推送
  2. 解析该角色回复末尾的 @mention
  3. 按上面规则路由（有 @ 转发，无 @ 兜底给 Leader）
  4. 检查该角色的等待队列:
     if 有排队消息 → 合并成一条 → 发给该角色
```

**特殊情况：Leader 自己的回复无 @** → 不兜底给自己，视为最终输出，不转发。

没有 DispatchRound，没有 GroupTurn 状态机，没有 initiator 追踪。

### 2.2 完整场景推演

```
用户: "@PM 做个报告"

① App 解析 @PM → PM 空闲 → 转发
   PM 收到: "[来自 用户]: 做个报告"

② PM 回复: "我来安排分工。\n\n@分析师 @撰稿人"
   App 存入 panel + SSE
   App 解析 → @分析师 @撰稿人
   两者都空闲 → 并行转发:
     分析师 ← "[来自 PM]: 我来安排分工。..."
     撰稿人 ← "[来自 PM]: 我来安排分工。..."

③ 分析师回复: "Q1=500万...\n\n@PM"
   App 存入 panel + SSE
   App 解析 → @PM
   PM 空闲 → 转发
   PM 收到: "[来自 分析师]: Q1=500万..."
   PM 开始推理

④ 撰稿人回复: "模板准备好了\n\n@PM"
   App 存入 panel + SSE
   App 解析 → @PM
   PM 正在推理 → 入队: { sender: "撰稿人", text: "模板准备好了" }

⑤ PM 推理完成，回复: "收到数据，等撰稿人的模板"（无 @）
   App 存入 panel + SSE
   无 @mention → 不转发
   检查 PM 队列 → 有撰稿人的消息 → 发给 PM:
   "[来自 撰稿人]: 模板准备好了"

⑥ PM 推理完成，回复: "数据和模板都有了。\n\n@撰稿人"
   App 存入 panel + SSE
   App 解析 → @撰稿人
   撰稿人空闲 → 转发:
   撰稿人 ← "[来自 PM]: 数据和模板都有了。..."

⑦ 撰稿人回复: "报告已完成...\n\n@PM"
   App 存入 panel + SSE
   App 解析 → @PM → PM 空闲 → 转发

⑧ PM 回复: "最终版本如下..."（无 @）
   App 存入 panel + SSE
   无 @mention → 不转发
   PM 队列为空 → 系统静止
```

### 2.3 另一种可能：PM 不需要中间回复

步骤 ⑤ 中 PM 可能直接综合处理队列中的消息，不产生"等撰稿人"这种中间回复。
取决于 LLM 的行为——这不是 App 需要关心的。

如果分析师和撰稿人几乎同时完成：
- 分析师 @PM → PM 空闲 → 转发 → PM 开始推理
- 撰稿人 @PM → PM 忙 → 入队
- PM 推理完 → 检查队列 → 发送撰稿人的消息 → PM 继续处理

如果分析师和撰稿人真的同时到达（PM 还没开始推理）：
- 分析师 @PM → PM 空闲 → 转发 → PM 标记为忙（dispatch 已发出）
- 撰稿人 @PM → PM 忙 → 入队

无论哪种情况，队列机制都能正确处理。

## 3. 消息队列

### 3.1 数据结构

```ts
// lib/group-router.ts

interface QueuedMessage {
  senderType: "user" | "group-role";
  senderLabel: string;
  text: string;
  timestamp: number;
}

/**
 * 每个角色的消息等待队列
 * key: `${panelId}:${groupRoleId}`
 */
const pendingQueues = new Map<string, QueuedMessage[]>();

/**
 * 当前正在推理的角色集合
 * key: `${panelId}:${groupRoleId}`
 * value: runId
 */
const busyRoles = new Map<string, string>();
```

### 3.2 入队

```ts
function enqueueMessage(panelId: string, groupRoleId: string, msg: QueuedMessage) {
  const key = `${panelId}:${groupRoleId}`;
  const queue = pendingQueues.get(key) ?? [];
  queue.push(msg);
  pendingQueues.set(key, queue);
}
```

### 3.3 出队 + 合并发送

```ts
async function flushQueue(panelId: string, groupRoleId: string) {
  const key = `${panelId}:${groupRoleId}`;
  const queue = pendingQueues.get(key);
  if (!queue || queue.length === 0) return;

  // 清空队列
  pendingQueues.delete(key);

  // 合并消息
  const combined = queue
    .map(msg => `[来自 ${msg.senderLabel}]:\n${msg.text}`)
    .join("\n\n");

  // dispatch 给角色
  await dispatchToRole({
    panelId,
    groupRoleId,
    text: combined,
    isFirstCall: false,
  });
}
```

### 3.4 角色忙闲判断

```ts
function isRoleBusy(panelId: string, groupRoleId: string): boolean {
  return busyRoles.has(`${panelId}:${groupRoleId}`);
}

function markRoleBusy(panelId: string, groupRoleId: string, runId: string) {
  busyRoles.set(`${panelId}:${groupRoleId}`, runId);
}

function markRoleIdle(panelId: string, groupRoleId: string) {
  busyRoles.delete(`${panelId}:${groupRoleId}`);
}
```

## 4. 转发流程

### 4.1 routeMessage — 核心路由函数

```ts
/**
 * 路由一条消息：解析末尾 @mention，转发或入队；无 @ 则兜底给 Leader
 */
async function routeMessage(params: {
  panelId: string;
  senderType: "user" | "group-role";
  senderLabel: string;
  senderGroupRoleId?: string;
  text: string;           // 包含末尾 @mention 的完整文本
  groupRoles: StoredGroupRole[];
}) {
  // 1. 解析末尾 @mention
  const mentions = parseTrailingMentions(params.text, params.groupRoles);
  const instruction = extractInstructionText(params.text);

  // 2. 确定转发目标
  let targets: StoredGroupRole[];

  if (mentions.length > 0) {
    // 有显式 @mention → 转发给被 @ 的角色
    targets = mentions.filter(r => r.id !== params.senderGroupRoleId);
  } else if (params.senderType === "group-role") {
    // 角色回复无 @ → 兜底给 Leader
    const leader = params.groupRoles.find(r => r.isLeader && r.enabled);
    if (leader && leader.id !== params.senderGroupRoleId) {
      // Leader 存在且不是发送者自己 → 兜底转发
      targets = [leader];
    } else {
      // 没有 Leader，或者发送者就是 Leader → 不转发
      return;
    }
  } else {
    // 用户消息无 @ → 不转发（前端应提示用户 @ 角色）
    return;
  }

  // 3. 对每个目标角色执行转发或入队
  for (const targetRole of targets) {
    const msg: QueuedMessage = {
      senderType: params.senderType,
      senderLabel: params.senderLabel,
      text: instruction,
      timestamp: Date.now(),
    };

    if (isRoleBusy(params.panelId, targetRole.id)) {
      enqueueMessage(params.panelId, targetRole.id, msg);
    } else {
      await dispatchToRole({
        panelId: params.panelId,
        groupRoleId: targetRole.id,
        agentId: targetRole.agentId,
        text: buildDispatchMessage({
          targetRole,
          allRoles: params.groupRoles,
          sender: { type: params.senderType, name: params.senderLabel },
          instruction,
          isFirstCall: !hasBeenInitialized(params.panelId, targetRole.id),
        }),
      });
    }
  }
}
```

### 4.2 dispatchToRole — 发送给角色的 Gateway session

```ts
async function dispatchToRole(params: {
  panelId: string;
  groupRoleId: string;
  agentId: string;
  text: string;
}) {
  const messageId = crypto.randomUUID();

  const response = await fetch(buildProviderIngressUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.providerToken}`,
    },
    body: JSON.stringify({
      panelId: params.panelId,
      agentId: params.agentId,
      target: `grp:${params.panelId}:r:${params.groupRoleId}`,
      messageId,
      text: params.text,
    }),
  });

  const payload = await response.json();
  const runId = payload?.runId || messageId;

  // 标记角色为忙
  markRoleBusy(params.panelId, params.groupRoleId, runId);

  // 记录 runId → groupRoleId 映射（供 ingest 回流时使用）
  runToRole.set(runId, {
    panelId: params.panelId,
    groupRoleId: params.groupRoleId,
  });
}
```

### 4.3 onRoleReplyFinal — ingest 中角色回复完成时调用

```ts
async function onRoleReplyFinal(params: {
  panelId: string;
  groupRoleId: string;
  senderLabel: string;
  replyText: string;
  groupRoles: StoredGroupRole[];
}) {
  // 1. 标记角色为空闲
  markRoleIdle(params.panelId, params.groupRoleId);

  // 2. 路由该回复中的 @mention
  await routeMessage({
    panelId: params.panelId,
    senderType: "group-role",
    senderLabel: params.senderLabel,
    senderGroupRoleId: params.groupRoleId,
    text: params.replyText,
    groupRoles: params.groupRoles,
  });

  // 3. 刷出该角色的等待队列（如果有排队消息）
  await flushQueue(params.panelId, params.groupRoleId);
}
```

注意步骤 2 和 3 的顺序：**先路由 @mention，再刷队列**。

因为如果回复中有 @mention，说明角色主动发出了新的指令。这些指令转发后，角色才应该处理自己的排队消息。但实际上 routeMessage 只是转发给其他角色，不影响当前角色。所以顺序是：

```
角色回复完成
→ 先看回复有没有 @谁 → 转发出去
→ 再看自己有没有排队消息 → 有就处理
```

如果回复有 @mention 同时自己也有排队消息：两件事互不冲突。@mention 的目标是其他角色，排队消息是发给自己的。但这里有一个微妙点：

**角色刚回复完就立即收到排队消息，会马上进入下一轮推理。** 这意味着如果角色 @了其他角色并期望等待回复，它不会"等"——它会先处理自己的排队消息。

这其实没问题：角色不需要"等待"。它处理排队消息后会再次回复，该回复同样会被路由。之前 @的角色完成后回复 @本角色，消息会入队或直接发送，形成自然的异步对话流。

## 5. @mention 解析

### 5.1 parseTrailingMentions

```ts
/**
 * 从文本末尾提取 @mention
 * 只检查最后 3 行，避免误匹配正文
 */
function parseTrailingMentions(text: string, roles: StoredGroupRole[]): StoredGroupRole[] {
  const lines = text.trimEnd().split("\n");
  const tail = lines.slice(-3).join("\n");

  const enabledRoles = roles.filter(r => r.enabled);
  // 按名字长度降序，防止短名先匹配
  enabledRoles.sort((a, b) => b.title.length - a.title.length);

  const mentioned: StoredGroupRole[] = [];
  for (const role of enabledRoles) {
    const pattern = new RegExp(`@${escapeRegExp(role.title)}(?:\\s|$)`);
    if (pattern.test(tail)) {
      mentioned.push(role);
    }
  }

  return mentioned;
}
```

### 5.2 extractInstructionText

```ts
/**
 * 去掉末尾 @mention 行，返回正文部分
 */
function extractInstructionText(text: string): string {
  const lines = text.trimEnd().split("\n");

  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (/^(@\S+\s*)+$/.test(last) || last === "") {
      lines.pop();
    } else {
      break;
    }
  }

  return lines.join("\n").trim();
}
```

### 5.3 buildDispatchMessage

```ts
function buildDispatchMessage(params: {
  targetRole: StoredGroupRole;
  allRoles: StoredGroupRole[];
  sender: { type: "user" | "group-role"; name: string };
  instruction: string;
  isFirstCall: boolean;
}): string {
  const parts: string[] = [];

  if (params.isFirstCall) {
    // 成员列表（标注组长）
    const others = params.allRoles
      .filter(r => r.id !== params.targetRole.id && r.enabled)
      .map(r => r.isLeader ? `- ${r.title}（组长）` : `- ${r.title}`)
      .join("\n");

    const isLeader = params.targetRole.isLeader === true;
    const roleDesc = isLeader
      ? `你的角色名是「${params.targetRole.title}」，你是本群组的组长。`
      : `你的角色名是「${params.targetRole.title}」。`;

    parts.push(
      `[群组信息]`,
      `你正在一个群组中协作，${roleDesc}`,
      `群组内的其他成员：`,
      others,
      ``,
      `[消息规则]`,
      `1. 你收到的每条消息会标明来源：「用户」或「某个角色名」。`,
      `2. 如果你需要其他成员协助，请在回复的末尾另起一行，写上 @角色名。`,
      `3. 你的回复需要转交给某人时，也请在末尾写 @角色名。`,
      `4. 如果你的回复是最终结果、不需要转发给任何人，则不要在末尾写 @。`,
      `5. 完成其他成员交给你的任务后，务必在末尾 @对方，否则对方无法收到你的回复。`,
      `6. 你只能看到发给你的消息，无法直接看到其他成员之间的对话。`,
    );

    // Leader 专属职责说明
    if (isLeader) {
      parts.push(
        ``,
        `[组长职责]`,
        `作为组长，当你收到来源不明或未指定接收人的消息时，你需要：`,
        `1. 根据消息内容和上下文判断这条消息的意图。`,
        `2. 如果需要某个成员处理，在你的回复末尾 @该成员。`,
        `3. 如果消息是某个成员的任务完成汇报，理解内容后决定下一步行动。`,
        `4. 如果不需要进一步操作，正常回复即可，不要在末尾 @任何人。`,
      );
    }

    parts.push(
      ``,
      `[回复格式示例]`,
      `这里是你的回复正文。`,
      ``,
      `@角色名`,
      ``,
    );
  }

  const senderLabel = params.sender.type === "user" ? "用户" : params.sender.name;
  parts.push(`[来自 ${senderLabel}]:`, params.instruction);

  return parts.join("\n");
}
```

## 6. 首次调用标记

### 6.1 跟踪

```ts
/**
 * 记录每个角色是否已注入过群组信息
 * key: `${panelId}:${groupRoleId}`
 */
const initializedRoles = new Set<string>();

function hasBeenInitialized(panelId: string, groupRoleId: string): boolean {
  return initializedRoles.has(`${panelId}:${groupRoleId}`);
}

function markInitialized(panelId: string, groupRoleId: string) {
  initializedRoles.add(`${panelId}:${groupRoleId}`);
}
```

### 6.2 何时重新注入

- 群组新增/移除角色后，对所有角色重置标记 → 下次调用时重新注入最新的成员列表
- App 重启后标记丢失 → 每个角色首次被调用时自然重新注入（冗余但无害）

## 7. 安全阀

### 7.1 限额

```ts
const SAFETY_LIMITS = {
  /** 每个群组 panel 每分钟最大 dispatch 次数 */
  maxDispatchesPerMinute: 30,
  /** 单个角色的最大队列深度 */
  maxQueueDepth: 10,
};
```

### 7.2 计数

```ts
/**
 * 滑动窗口计数器
 * key: panelId
 */
const dispatchCounters = new Map<string, { count: number; windowStart: number }>();

function checkDispatchLimit(panelId: string): boolean {
  const now = Date.now();
  const counter = dispatchCounters.get(panelId);

  if (!counter || now - counter.windowStart > 60_000) {
    dispatchCounters.set(panelId, { count: 1, windowStart: now });
    return true;
  }

  if (counter.count >= SAFETY_LIMITS.maxDispatchesPerMinute) {
    return false;  // 超限
  }

  counter.count++;
  return true;
}
```

### 7.3 超限时的行为

```ts
if (!checkDispatchLimit(panelId)) {
  // 忽略 @mention，不转发
  // 向群组 panel 追加系统消息
  await appendSystemMessage(panelId, "群组消息频率达到上限，暂停转发。请稍后再试。");
  return;
}

// 队列深度检查
if (getQueueDepth(panelId, groupRoleId) >= SAFETY_LIMITS.maxQueueDepth) {
  await appendSystemMessage(panelId, `${roleTitle} 的消息队列已满，新消息被丢弃。`);
  return;
}
```

## 8. 完整数据流图

```
用户: "@PM 做报告"
          │
          ▼
    ┌─ App 路由 ─┐
    │ 解析 @PM   │
    │ PM 空闲    │
    │ 转发       │
    └────────────┘
          │
          ▼
    PM session: [user] "[来自 用户]: 做报告"
    PM 回复: "安排分工\n\n@分析师 @撰稿人"
          │
          ▼
    ┌─ App 路由 ─┐
    │ 解析 @分析师 @撰稿人   │
    │ 都空闲 → 并行转发      │
    └────────────────────────┘
          │                   │
          ▼                   ▼
    分析师 session          撰稿人 session
    回复: "数据..@PM"      回复: "模板..@PM"
          │                   │
          ▼                   ▼
    ┌─ App 路由 ─┐      ┌─ App 路由 ─┐
    │ @PM        │      │ @PM        │
    │ PM 空闲    │      │ PM 忙      │
    │ → 转发     │      │ → 入队     │
    └────────────┘      └────────────┘
          │
          ▼
    PM session: [user] "[来自 分析师]: 数据..."
    PM 回复: "收到数据"（无 @）
          │
          ▼
    ┌─ App ──────────────┐
    │ 无 @mention        │
    │ 检查 PM 队列       │
    │ → 有撰稿人消息     │
    │ → 发送合并消息     │
    └────────────────────┘
          │
          ▼
    PM session: [user] "[来自 撰稿人]: 模板..."
    PM 回复: "填充报告\n\n@撰稿人"
          │
          ▼
    ... 继续路由 ...
          │
          ▼
    PM 回复: "最终报告"（无 @）
    PM 队列为空 → 系统静止

    ═══ 群组 panel 中的消息（全部可见）═══
    用户:    @PM 做报告
    PM:      安排分工             → @分析师 @撰稿人
    分析师:  数据...              → @PM
    撰稿人:  模板...              → @PM
    PM:      收到数据
    PM:      填充报告             → @撰稿人
    撰稿人:  报告已完成           → @PM
    PM:      最终报告
```

## 9. 前端展示

### 9.1 消息气泡

每条消息根据 `groupRoleId` + `senderLabel` 渲染发送者标签。

**末尾 @mention 的展示**：从正文中剥离末尾 @ 行，在气泡右下角展示被 @ 角色的头像/emoji + 名字。

```
┌──────────────────────────────────┐
│ [PM头像] PM                       │
│                                    │
│ 安排分工。分析师收集数据，          │
│ 撰稿人准备模板。                   │
│                                    │
│              [分析师emoji] [撰稿人emoji] │
└──────────────────────────────────┘
```

剥离规则与后端一致：**只剥离末尾连续的 @ 行**。正文中间出现的 @角色名 保留在正文中，不做处理。

### 9.2 @ 输入辅助

群组输入框提供 @ 快捷入口：

- 输入 `@` 字符时弹出角色候选列表
- 或点击输入框旁的 **@按钮** 直接弹出角色列表
- 候选列表展示角色名 + emoji/头像
- 点击后自动插入 `@角色名 ` 到输入框

### 9.3 群组忙碌状态

前端如何知道群组还在"工作中"：

- 任何角色有 activeRunId → 输入框显示"角色X 正在思考..."
- 所有角色都空闲 + 所有队列为空 → 系统静止，用户可输入

不需要 `activeGroupTurnId`。前端只需要知道是否有角色在推理：

```ts
// SSE 事件中携带 groupRoleId
// 前端根据 state=delta 和 state=final 跟踪哪些角色在推理

// 是否禁用输入框？不禁用。
// 用户随时可以发新消息（@新的角色或同一个角色）。
// 如果目标角色忙 → App 自动排队。
```

**不禁用输入框** — 用户随时可以发消息。如果目标角色正在推理，消息自动排队。这比强制等待体验更好。

## 10. 数据模型

### 10.1 StoredPanel 扩展

```ts
interface StoredPanel {
  // ... 现有字段不变 ...
  kind?: "direct" | "group";   // 新增，默认 "direct"
}
```

`agentId` 保持 `string` 类型，群组时设为 `""`。

不需要 `activeGroupTurnId` — 前端通过 SSE 事件中的 `groupRoleId` + `state` 自行跟踪。

### 10.2 StoredGroupRole（新增）

```ts
interface StoredGroupRole {
  id: string;
  panelId: string;
  agentId: string;
  title: string;             // 角色显示名 = @mention 匹配名
  emoji?: string | null;
  isLeader?: boolean;        // 组长标记，每个群组有且仅有一个
  enabled: boolean;          // 软删除
  createdAt: string;
  updatedAt: string;
}
```

**Leader 规则**：
- 每个群组有且仅有一个 `isLeader=true` 的角色
- 设置新 Leader 时自动取消旧 Leader 的标记
- 前端在成员列表中为 Leader 显示红色「组长」标签
- 创建群组时不强制指定 Leader；未指定 Leader 的群组中，无 @ 的角色回复不做兜底转发

### 10.3 StoredMessage 扩展

```ts
interface StoredMessage {
  // ... 现有字段 ...
  groupRoleId?: string | null;         // 哪个角色发的
  senderLabel?: string | null;         // 发送者名字快照
  mentionedGroupRoleIds?: string[];    // 末尾 @ 了谁（供前端右下角展示）
}
```

不需要 `groupTurnId` — 没有 turn 概念了。

### 10.4 AppData 扩展

```ts
interface AppData {
  users: StoredUser[];
  panels: StoredPanel[];
  messages: StoredMessage[];
  groupRoles: StoredGroupRole[];    // 新增
}
```

### 10.5 ChatEventPayload 扩展

```ts
interface ChatEventPayload {
  // ... 现有字段 ...
  groupRoleId?: string;
  senderLabel?: string;
  mentionedGroupRoleIds?: string[];
}
```

## 11. Target 与 Session

### 11.1 Target 格式

```
grp:{panelId}:r:{groupRoleId}
```

### 11.2 SessionKey 格式

```
agent:{agentId}:customchat:grp:{panelId}:r:{groupRoleId}
```

### 11.3 normalizeCustomChatTarget 改动

```ts
// lib/utils.ts
if (trimmed.startsWith("grp:")) {
  const match = trimmed.match(/^grp:([^:]+):r:.+$/);
  return match ? `panel:${match[1]}` : null;
}
```

### 11.4 extractGroupRoleIdFromTarget

```ts
// lib/utils.ts（新增）
function extractGroupRoleIdFromTarget(target: string): string | null {
  const match = target.match(/^grp:[^:]+:r:(.+)$/);
  return match?.[1] ?? null;
}
```

### 11.5 插件 utils.ts 改动

```ts
// normalizeChannelTarget — 新增
if (target.startsWith("grp:")) {
  return target;  // 透传
}

// buildCanonicalSessionKey — 新增
if (target.startsWith("grp:")) {
  return `agent:${agentId}:customchat:${target}`;
}
```

## 12. SSE 事件匹配

```ts
function matchesPanelSession(
  eventSessionKey: string,
  panelSessionKey: string,
  panelId: string,
  panelKind?: string,
): boolean {
  if (eventSessionKey === panelSessionKey) return true;

  const eventNorm = normalizeCustomChatTarget(eventSessionKey);
  const panelNorm = normalizeCustomChatTarget(panelSessionKey);
  if (eventNorm && panelNorm && eventNorm === panelNorm) return true;

  // 群组：事件来自该 panel 下的任意角色
  if (panelKind === "group" && eventNorm === `panel:${panelId}`) {
    return true;
  }

  return false;
}
```

## 13. ingest 层改动

`ingestCustomChatDelivery()` 中新增群组处理：

```ts
// 从 target 解析 groupRoleId
const groupRoleId = extractGroupRoleIdFromTarget(targetHint);

if (groupRoleId) {
  // 查找角色信息（用于 senderLabel）
  const groupRoles = await listGroupRoles(panel.id);
  const role = groupRoles.find(r => r.id === groupRoleId);
  const senderLabel = role?.title ?? "未知角色";

  // upsert 时带上 groupRoleId 和 senderLabel
  // ... 现有 upsert 逻辑，新增字段 ...

  // SSE payload 中也带上
  payload.groupRoleId = groupRoleId;
  payload.senderLabel = senderLabel;

  // 解析末尾 @mention，填入 mentionedGroupRoleIds
  const mentions = parseTrailingMentions(text, groupRoles);
  payload.mentionedGroupRoleIds = mentions.map(r => r.id);

  // state=final 时触发路由
  if (parsed.state === "final") {
    void onRoleReplyFinal({
      panelId: panel.id,
      groupRoleId,
      senderLabel,
      replyText: text,
      groupRoles,
    });
  }
}
```

## 14. 错误处理

### 14.1 角色推理失败

```ts
if (parsed.state === "error" || parsed.state === "aborted") {
  // 标记角色为空闲
  markRoleIdle(panelId, groupRoleId);

  // 刷出队列（让排队的消息继续发送）
  await flushQueue(panelId, groupRoleId);

  // 错误消息已经通过正常 ingest 流程存入 panel + SSE
  // 前端自然展示错误气泡
}
```

### 14.2 dispatch 本身失败

```ts
try {
  await dispatchToRole(params);
} catch (err) {
  // dispatch 失败 → 角色不会变成"忙"状态
  // 向群组追加系统消息
  await appendSystemMessage(panelId, `无法将消息发送给 ${roleTitle}：${err.message}`);
}
```

## 15. 代码变更清单

### 新增文件

| 文件 | 职责 |
|------|------|
| `lib/group-router.ts` | routeMessage, dispatchToRole, 消息队列, 忙闲管理 |
| `lib/group-message.ts` | submitGroupMessage（webhook 入口） |
| `lib/mention-parser.ts` | parseTrailingMentions, extractInstructionText, buildDispatchMessage |

### 修改文件

| 文件 | 改动 |
|------|------|
| `lib/types.ts` | 新增 StoredGroupRole / GroupRoleView，扩展 StoredPanel / StoredMessage / ChatEventPayload |
| `lib/store.ts` | 新增 groupRole CRUD（含 setLeader） |
| `lib/utils.ts` | normalizeCustomChatTarget 和 extractGroupRoleIdFromTarget |
| `lib/customchat-ingest.ts` | 解析 grp target、附带 groupRoleId、state=final 时调用 onRoleReplyFinal |
| `app/api/customchat/webhook/route.ts` | 群组分支 → submitGroupMessage |
| `app/api/panels/[panelId]/stream/route.ts` | SSE 匹配扩展 |
| `plugins/customchat/utils.ts` | normalizeChannelTarget + buildCanonicalSessionKey 支持 grp: |

### 不改动

| 代码 | 原因 |
|------|------|
| `lib/panel-message.ts` | 仅 kind=direct |
| `lib/customchat-provider.ts` | abort/delete 可复用 |
| 插件 `index.ts` 主体 | target 原样透传 |
| Gateway | 零改动 |

## 16. 实施顺序

### Step 1: 基础层
- `lib/types.ts` 扩展
- `lib/store.ts` 新增 groupRole CRUD
- `lib/mention-parser.ts` 纯函数 + 单元测试
- `lib/utils.ts` grp: target 解析 + 单元测试
- `plugins/customchat/utils.ts` 适配 + 单元测试

### Step 2: 路由核心
- `lib/group-router.ts` — 路由 + 队列 + 忙闲管理
- `lib/group-message.ts` — submitGroupMessage
- `lib/customchat-ingest.ts` — 回流时触发 onRoleReplyFinal

### Step 3: API + 前端
- webhook 路由分支
- SSE 匹配扩展
- 群组 CRUD API（`POST /api/groups`, `/api/groups/[id]/roles`, `PATCH /api/groups/[id]/roles/[roleId]/leader`）
- 前端：侧边栏群组项、群组聊天页、@ 候选弹窗、气泡右下角 @ 展示

### Step 4: 安全 + 测试
- 频率限制 + 队列深度限制
- 单元测试（mention 解析、消息构造、队列逻辑）
- 集成测试（模拟多角色路由 + 排队）
- 手工联调
