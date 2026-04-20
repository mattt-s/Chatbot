"use client";

/**
 * @module task-mode/task-mode-panel-card
 * 任务模式顶层面板组件。
 * 完全独立于聊天模式的 panel-card.tsx，有自己的 SSE 订阅、状态管理和 UI。
 *
 * TODO: 实现完整的任务模式 UI（对话区 + 任务看板）。
 * 当前为骨架版本，仅展示群组名称和"任务模式"标识。
 */

import type { AgentView, PanelView } from "@/lib/types";

interface TaskModePanelCardProps {
  panel: PanelView;
  agents: AgentView[];
  onOpenSidebar?: () => void;
  onPanelReplaced?: (panel: PanelView) => void;
}

export function TaskModePanelCard({
  panel,
}: TaskModePanelCardProps) {
  return (
    <div className="flex flex-col h-full items-center justify-center gap-3 text-muted-foreground">
      <div className="text-lg font-medium">{panel.title}</div>
      <div className="text-sm px-3 py-1 rounded-full bg-muted">🗂 任务模式</div>
      <div className="text-xs opacity-60">任务看板 UI 开发中…</div>
    </div>
  );
}
