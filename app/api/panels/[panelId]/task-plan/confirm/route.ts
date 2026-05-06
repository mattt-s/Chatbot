/**
 * @file POST /api/panels/[panelId]/task-plan/confirm
 * 用户确认规划方案，切换到执行阶段：
 * 1. plan.status → confirmed
 * 2. 向 Leader 发送系统消息，注入执行阶段提示词 + 完整 Plan 内容
 * 3. 重置 leader 的 firstDispatch 标记（使执行阶段提示词能重新注入）
 */
import "server-only";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { getPanelRecordForUser, listGroupRoles } from "@/lib/store";
import { confirmTaskModePlan, getTaskModePlan } from "@/lib/task-mode/plan-store";
import { resetTaskModeInitialized, markTaskModeInitialized } from "@/lib/task-mode/dispatch";
import {
  ensureCustomChatBridgeServer,
  sendInboundToPlugin,
} from "@/lib/customchat-bridge-server";
import { toCustomChatGroupRoleTarget } from "@/lib/utils";

type RouteContext = { params: Promise<{ panelId: string }> };

const PROMPT_DIR = path.join(process.cwd(), "prompt");

function loadPrompt(filename: string): string {
  try {
    return fs.readFileSync(path.join(PROMPT_DIR, filename), "utf-8");
  } catch {
    return "";
  }
}

function applyVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

function formatList(items: string[]): string {
  return items.length === 0 ? "（未填写）" : items.map((s) => `- ${s}`).join("\n");
}

export async function POST(_req: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { panelId } = await context.params;
  const panel = await getPanelRecordForUser(user.id, panelId).catch(() => null);
  if (!panel) return NextResponse.json({ error: "Panel not found." }, { status: 404 });

  // Fix 5: Idempotency — return early if already confirmed
  const existingPlan = await getTaskModePlan(panelId);
  if (existingPlan?.status === "confirmed") {
    return NextResponse.json({ ok: true, plan: existingPlan });
  }

  // Fix 3: Validate plan has a goal before confirming
  if (!existingPlan || !existingPlan.goal.trim()) {
    return NextResponse.json(
      { error: "计划目标不能为空，请先完成规划对话。" },
      { status: 422 },
    );
  }

  // 1. 确认 Plan
  const plan = await confirmTaskModePlan(panelId);

  // 2. 查找 Leader
  const roles = await listGroupRoles(panelId);
  const leader = roles.find((r) => r.isLeader && r.enabled);
  if (!leader) return NextResponse.json({ ok: true, plan });

  // 3. 构造执行阶段注入消息
  const leaderPrompt = loadPrompt("group-task-leader.md");
  const membersList =
    roles
      .filter((r) => r.enabled && r.id !== leader.id)
      .map((r) => (r.isLeader ? `- ${r.title}（组长）` : `- ${r.title}`))
      .join("\n") || "（暂无其他成员）";

  const executionPrompt = leaderPrompt
    ? applyVars(leaderPrompt, {
        ROLE_NAME: leader.title,
        GROUP_NAME: panel.title,
        MEMBERS_LIST: membersList,
        PANEL_ID: panelId,
      })
    : "";

  const planSummary = [
    `【已确认计划】`,
    `目标：${plan.goal || "（未填写）"}`,
    ``,
    `约束条件：\n${formatList(plan.constraints)}`,
    ``,
    `交付物：\n${formatList(plan.deliverables)}`,
    ``,
    `验收标准：\n${formatList(plan.acceptanceCriteria)}`,
    ``,
    `任务草稿：\n${formatList(plan.taskOutline)}`,
  ].join("\n");

  const textToSend = [
    executionPrompt,
    "",
    planSummary,
    "",
    "[系统] 用户已确认以上规划方案，现在进入执行阶段。",
    "请根据计划立即开始调用 group_task(create_task) 创建细化任务并分配给各成员。",
  ]
    .filter(Boolean)
    .join("\n");

  // 4. 重置 firstDispatch 标记（使执行阶段提示词能通过 dispatchTaskMessage 首次检查重新注入）
  resetTaskModeInitialized(panelId, leader.id);

  // 5. 发送到 Leader
  await ensureCustomChatBridgeServer();
  const messageId = crypto.randomUUID();
  const target = toCustomChatGroupRoleTarget(panelId, leader.id);

  await sendInboundToPlugin({
    panelId,
    agentId: leader.agentId,
    target,
    messageId,
    text: textToSend,
    attachments: [],
  });

  // Fix 4: Re-mark so user's next message doesn't re-inject the execution prompt again
  markTaskModeInitialized(panelId, leader.id);

  return NextResponse.json({ ok: true, plan });
}
