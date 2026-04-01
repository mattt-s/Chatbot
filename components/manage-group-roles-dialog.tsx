/**
 * @file 群组角色管理对话框组件。
 *
 * 显示群组内所有角色列表，支持设置/取消组长、删除角色。
 */
"use client";

import { useEffect, useState } from "react";
import type { GroupRoleView } from "@/lib/types";

function formatBusyAge(ms: number | null | undefined) {
  if (!ms || ms <= 0) return "刚刚进入";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

/**
 * 角色管理对话框配置。
 */
export type ManageGroupRolesDialogConfig = {
  open: boolean;
  panelId: string;
  roles: GroupRoleView[];
};

/**
 * 群组角色管理模态对话框。
 *
 * @param props.config - 对话框配置
 * @param props.onClose - 关闭回调
 * @param props.onDeleteRole - 删除角色回调
 * @param props.onToggleLeader - 切换组长状态回调
 */
export function ManageGroupRolesDialog({
  config,
  onClose,
  onDeleteRole,
  onToggleLeader,
  onAbortRole,
}: {
  config: ManageGroupRolesDialogConfig | null;
  onClose: () => void;
  onDeleteRole: (panelId: string, roleId: string) => Promise<void> | void;
  onToggleLeader: (panelId: string, roleId: string, isLeader: boolean) => Promise<void> | void;
  onAbortRole: (panelId: string, roleId: string) => Promise<void> | void;
}) {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [abortingId, setAbortingId] = useState<string | null>(null);

  useEffect(() => {
    if (!config?.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deletingId && !togglingId) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [config, deletingId, togglingId, onClose]);

  if (!config?.open) return null;

  const enabledRoles = config.roles.filter((r) => r.enabled);

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/30 px-4 backdrop-blur-[2px]">
      <div className="w-full max-w-md rounded-[28px] border border-black/10 bg-[var(--paper)] p-5 shadow-[0_28px_90px_rgba(12,18,28,0.24)]">
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold text-[var(--ink)]">角色管理</div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-black/10 text-sm text-[var(--ink-soft)] transition hover:border-[var(--accent)]"
          >
            ×
          </button>
        </div>

        <div className="mt-4 max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          {enabledRoles.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-black/10 bg-white/70 px-4 py-8 text-center text-sm text-[var(--ink-soft)]">
              暂无角色，点击「添加角色」新增。
            </div>
          ) : (
            enabledRoles.map((role, index) => (
              <div
                key={role.id}
                className="flex items-center gap-3 rounded-2xl border border-black/8 bg-white px-4 py-3"
              >
                {/* 角色头像 */}
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-black/8 bg-white text-sm font-semibold text-[var(--ink-soft)]">
                  {role.emoji || String(index + 1)}
                </div>

                {/* 角色信息 */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-[var(--ink)]">
                      {role.title}
                    </span>
                    {role.isLeader && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                        组长
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        role.runtimeStatus === "aborting"
                          ? "bg-red-100 text-red-700"
                          : role.runtimeStatus === "checking"
                            ? "bg-amber-100 text-amber-700"
                            : role.runtimeStatus === "busy"
                              ? "bg-sky-100 text-sky-700"
                              : "bg-emerald-100 text-emerald-700"
                      }`}
                    >
                      {role.runtimeStatus === "aborting"
                        ? "终止中"
                        : role.runtimeStatus === "checking"
                          ? "校验中"
                          : role.runtimeStatus === "busy"
                            ? "执行中"
                            : "空闲"}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-[var(--ink-soft)]">
                    Agent: {role.agentId}
                  </div>
                  {(role.runtimeStatus === "busy" || role.runtimeStatus === "checking" || role.runtimeStatus === "aborting") ? (
                    <div className="mt-0.5 text-[11px] text-[var(--ink-soft)]">
                      {role.busyAgeMs != null ? `已持续 ${formatBusyAge(role.busyAgeMs)}` : "正在处理中"}
                    </div>
                  ) : null}
                </div>

                {/* 操作按钮 */}
                <div className="flex shrink-0 items-center gap-1.5">
                  {(role.runtimeStatus === "busy" ||
                    role.runtimeStatus === "checking" ||
                    role.runtimeStatus === "aborting") ? (
                    <button
                      type="button"
                      disabled={abortingId === role.id || role.runtimeStatus === "aborting"}
                      onClick={async () => {
                        setAbortingId(role.id);
                        try {
                          await onAbortRole(config.panelId, role.id);
                        } finally {
                          setAbortingId(null);
                        }
                      }}
                      className="rounded-full border border-red-200 px-2.5 py-1 text-[10px] font-semibold text-red-600 transition hover:border-red-300 hover:bg-red-50 disabled:opacity-60"
                    >
                      {role.runtimeStatus === "aborting"
                        ? "终止中..."
                        : abortingId === role.id
                          ? "..."
                          : "终止推理"}
                    </button>
                  ) : null}

                  <button
                    type="button"
                    disabled={togglingId === role.id}
                    onClick={async () => {
                      setTogglingId(role.id);
                      try {
                        await onToggleLeader(config.panelId, role.id, role.isLeader);
                      } finally {
                        setTogglingId(null);
                      }
                    }}
                    className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold transition disabled:opacity-60 ${
                      role.isLeader
                        ? "border-amber-200 bg-amber-50 text-amber-700 hover:border-amber-300"
                        : "border-black/10 text-[var(--ink-soft)] hover:border-[var(--accent)]"
                    }`}
                    title={role.isLeader ? "取消组长" : "设为组长"}
                  >
                    {togglingId === role.id ? "..." : role.isLeader ? "取消组长" : "设为组长"}
                  </button>

                  <button
                    type="button"
                    disabled={deletingId === role.id}
                    onClick={async () => {
                      setDeletingId(role.id);
                      try {
                        await onDeleteRole(config.panelId, role.id);
                      } finally {
                        setDeletingId(null);
                      }
                    }}
                    className="rounded-full border border-red-200 px-2.5 py-1 text-[10px] font-semibold text-red-600 transition hover:border-red-300 hover:bg-red-50 disabled:opacity-60"
                  >
                    {deletingId === role.id ? "..." : "删除"}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
