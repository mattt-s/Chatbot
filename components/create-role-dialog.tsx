/**
 * @file 新增角色对话框组件。
 *
 * 让用户选择一个 Agent 并输入角色名称来创建新的 Role（面板）。
 * 每个 Role 对应独立的 session，同一 Agent 可创建多个 Role。
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import type { AgentView } from "@/lib/types";

/**
 * 新增角色对话框的配置。
 *
 * @property open - 是否打开对话框
 * @property initialTitle - 角色名称输入框的初始值
 * @property initialAgentId - Agent 选择器的初始值
 */
export type CreateRoleDialogConfig = {
  open: boolean;
  initialTitle: string;
  initialAgentId: string;
};

/**
 * 新增角色模态对话框。
 *
 * 渲染一个包含 Agent 下拉选择和角色名称输入的表单弹窗。
 * 支持 Escape 关闭，提交时调用 `onCreate` 回调。
 *
 * @param props.config - 对话框配置，为 null 或 open=false 时隐藏
 * @param props.agents - 可选的 Agent 列表
 * @param props.isSubmitting - 是否正在提交中（禁用交互）
 * @param props.onClose - 关闭回调
 * @param props.onCreate - 创建角色回调，接收 title 和 agentId
 */
export function CreateRoleDialog({
  config,
  agents,
  isSubmitting,
  onClose,
  onCreate,
}: {
  config: CreateRoleDialogConfig | null;
  agents: AgentView[];
  isSubmitting: boolean;
  onClose: () => void;
  onCreate: (input: { title: string; agentId: string }) => Promise<void> | void;
}) {
  const [title, setTitle] = useState("");
  const [agentId, setAgentId] = useState("");
  const availableAgents = useMemo(
    () =>
      agents.length > 0
        ? agents
        : [{ id: "main", name: "Main", emoji: null, avatarUrl: null, theme: null }],
    [agents],
  );

  useEffect(() => {
    if (!config?.open) {
      return;
    }

    setTitle(config.initialTitle);
    setAgentId(config.initialAgentId);
  }, [config]);

  useEffect(() => {
    if (!config?.open) {
      return;
    }

    if (availableAgents.some((agent) => agent.id === agentId)) {
      return;
    }

    setAgentId(availableAgents[0]?.id ?? "main");
  }, [agentId, availableAgents, config]);

  useEffect(() => {
    if (!config?.open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSubmitting) {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [config, isSubmitting, onClose]);

  if (!config?.open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 px-4 backdrop-blur-[2px]">
      <div className="w-full max-w-md rounded-[28px] border border-black/10 bg-[var(--paper)] p-5 shadow-[0_28px_90px_rgba(12,18,28,0.24)]">
        <div className="text-lg font-semibold text-[var(--ink)]">新增角色</div>
        <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
          先选择 agent，再创建一个新的 role。每个 role 都会使用独立 session，同一个 agent 也可以创建多个 role。
        </p>

        <div className="mt-5 space-y-4">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink-soft)]">
              Agent
            </span>
            <select
              className="h-11 w-full rounded-2xl border border-black/10 bg-white px-3 text-sm text-[var(--ink)] outline-none"
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              disabled={isSubmitting}
            >
              {availableAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.emoji ? `${agent.emoji} ` : ""}
                  {agent.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink-soft)]">
              Role Name
            </span>
            <input
              className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-base outline-none transition focus:border-[var(--accent)]"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={isSubmitting}
              placeholder="例如：Writer Session"
            />
          </label>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-full border border-black/10 px-4 py-2 text-sm font-medium text-[var(--ink-soft)] transition hover:border-[var(--accent)] disabled:opacity-60"
          >
            取消
          </button>
          <button
            type="button"
            disabled={isSubmitting || !agentId.trim() || !title.trim()}
            onClick={async () => {
              await onCreate({
                title: title.trim(),
                agentId: agentId.trim(),
              });
            }}
            className="rounded-full bg-[var(--ink)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
          >
            {isSubmitting ? "创建中..." : "创建角色"}
          </button>
        </div>
      </div>
    </div>
  );
}
