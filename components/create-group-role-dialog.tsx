/**
 * @file 添加群组角色对话框组件。
 *
 * 让用户输入角色名称并选择 Agent 来向群组中添加新角色。
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import type { AgentView } from "@/lib/types";

/**
 * 添加群组角色对话框配置。
 */
export type CreateGroupRoleDialogConfig = {
  open: boolean;
  panelId: string;
};

/**
 * 添加群组角色模态对话框。
 *
 * @param props.config - 对话框配置
 * @param props.agents - 可选的 Agent 列表
 * @param props.isSubmitting - 是否正在提交中
 * @param props.onClose - 关闭回调
 * @param props.onCreate - 创建角色回调
 */
export function CreateGroupRoleDialog({
  config,
  agents,
  isSubmitting,
  resetToken,
  onClose,
  onCreate,
}: {
  config: CreateGroupRoleDialogConfig | null;
  agents: AgentView[];
  isSubmitting: boolean;
  resetToken?: number;
  onClose: () => void;
  onCreate: (input: { panelId: string; title: string; agentId: string }) => Promise<void> | void;
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
    if (config?.open) {
      setTitle("");
      setAgentId(availableAgents[0]?.id ?? "main");
    }
  }, [config, availableAgents, resetToken]);

  useEffect(() => {
    if (!config?.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSubmitting) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [config, isSubmitting, onClose]);

  if (!config?.open) return null;

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 px-4 backdrop-blur-[2px]">
      <div className="w-full max-w-md rounded-[28px] border border-black/10 bg-[var(--paper)] p-5 shadow-[0_28px_90px_rgba(12,18,28,0.24)]">
        <div className="text-lg font-semibold text-[var(--ink)]">添加角色</div>
        <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
          为群组添加一个新角色，选择对应的 Agent 来驱动该角色。
        </p>

        <div className="mt-5 space-y-4">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-[var(--ink-soft)]">
              选择 Agent
            </span>
            <select
              className="h-11 w-full rounded-2xl border border-black/10 bg-white px-3 text-sm text-[var(--ink)] outline-none"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
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
              角色名称
            </span>
            <input
              className="w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-base outline-none transition focus:border-[var(--accent)]"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={isSubmitting}
              placeholder="例如：分析师"
              autoFocus
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
            disabled={isSubmitting || !title.trim() || !agentId.trim()}
            onClick={async () => {
              await onCreate({
                panelId: config.panelId,
                title: title.trim(),
                agentId: agentId.trim(),
              });
            }}
            className="rounded-full bg-[var(--ink)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
          >
            {isSubmitting ? "添加中..." : "添加角色"}
          </button>
        </div>
      </div>
    </div>
  );
}
