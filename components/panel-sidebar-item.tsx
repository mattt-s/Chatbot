/**
 * @file 侧边栏角色列表项组件。
 *
 * 在左侧角色列表中渲染单个面板条目，包含头像/首字母、
 * 标题、Agent 标签、最新消息预览，以及删除按钮。
 */
"use client";

import Image from "next/image";
import { getGroupTaskStateClassName, getGroupTaskStateLabel } from "@/lib/group-task";
import type { AgentView, PanelView } from "@/lib/types";
import { truncateText } from "./chat-helpers";

/**
 * 侧边栏角色列表项。
 *
 * 渲染单个面板在侧边栏中的卡片，包括 Agent 头像/首字母图标、
 * 角色标题（附 emoji）、Agent 标签、最新消息预览文本。
 * 选中时高亮显示，右上角提供删除按钮。
 *
 * @param props.panel - 面板数据
 * @param props.agentLabel - Agent 显示名称
 * @param props.agentEmoji - Agent emoji（可选）
 * @param props.agentAvatarUrl - Agent 头像 URL（可选）
 * @param props.isActive - 是否为当前活跃面板
 * @param props.onSelect - 选中回调
 * @param props.onDelete - 删除回调
 */
export function PanelSidebarItem({
  panel,
  agentLabel,
  agentEmoji,
  agentAvatarUrl,
  agents,
  isActive,
  onSelect,
  onDelete,
}: {
  panel: PanelView;
  agentLabel: string;
  agentEmoji?: string | null;
  agentAvatarUrl?: string | null;
  agents: AgentView[];
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const isGroup = panel.kind === "group";
  const cardToneClass = isActive
    ? "border-[#d8c7af] bg-[#f3ece2] text-[var(--ink)] shadow-[0_14px_30px_rgba(15,23,36,0.08)]"
    : "border-black/8 bg-white text-[var(--ink)] hover:border-[var(--accent)]";
  const softChipClass = isActive
    ? "bg-[#e9dece] text-[var(--ink-soft)]"
    : "bg-[var(--paper-2)] text-[var(--ink-soft)]";
  const avatarShellClass = isActive
    ? "bg-[#ebe1d2] text-[var(--ink-soft)]"
    : "bg-[var(--paper-2)] text-[var(--ink-soft)]";
  const bodyTextClass = "text-[var(--ink-soft)]";
  const latestMessage = panel.messages[panel.messages.length - 1];
  const previewSource =
    latestMessage?.text ||
    panel.latestMessagePreview ||
    (latestMessage?.draft ? "正在生成回复..." : "");
  const previewText = previewSource
    ? truncateText(previewSource.replace(/\s+/g, " "), 76)
    : isGroup ? "群组尚无消息" : "还没有消息";
  const titleWithEmoji = agentEmoji ? `${panel.title} ${agentEmoji}` : panel.title;

  const groupRoles = Array.isArray(panel.groupRoles)
    ? panel.groupRoles.filter((r) => r.enabled)
    : [];
  const groupRoleTiles = groupRoles.slice(0, 4).map((role) => {
    const agent = agents.find((candidate) => candidate.id === role.agentId);
    return {
      id: role.id,
      title: role.title,
      avatarUrl: agent?.avatarUrl ?? null,
      fallback: role.emoji || agent?.emoji || role.title.slice(0, 1) || "?",
    };
  });

  const sidebarIcon = isGroup ? (
    <div className="grid h-full w-full grid-cols-2 gap-0.5 p-1">
      {Array.from({ length: 4 }, (_, index) => {
        const tile = groupRoleTiles[index] ?? null;
        return (
          <div
            key={tile?.id ?? `empty-${index}`}
            className={`relative flex items-center justify-center overflow-hidden rounded-xl text-[11px] font-semibold ${
              tile
                ? isActive
                  ? "bg-white text-[var(--ink-soft)]"
                  : "bg-white text-[var(--ink-soft)]"
                : isActive
                  ? "bg-[#e1d5c6]"
                  : "bg-black/5"
            }`}
          >
            {tile ? (
              tile.avatarUrl ? (
                <Image
                  src={tile.avatarUrl}
                  alt={tile.title}
                  fill
                  unoptimized
                  sizes="20px"
                  className="object-cover"
                />
              ) : (
                tile.fallback
              )
            ) : null}
          </div>
        );
      })}
    </div>
  ) : agentAvatarUrl ? (
    <Image
      src={agentAvatarUrl}
      alt={panel.title || "Agent"}
      fill
      unoptimized
      sizes="44px"
      className="object-cover"
    />
  ) : (
    (panel.title || "A").slice(0, 1)
  );

  return (
    <div
      className={`relative rounded-[24px] border transition ${cardToneClass}`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="w-full rounded-[24px] px-3 py-3 pr-12 text-left"
      >
        <div className="flex items-start gap-3">
          <div
            className={`relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl text-sm font-semibold ${avatarShellClass}`}
          >
            {sidebarIcon}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold">{titleWithEmoji}</span>
              {isGroup ? (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${softChipClass}`}
                >
                  群组
                </span>
              ) : null}
              {isGroup ? (
                <span
                  className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${getGroupTaskStateClassName(panel.taskState)}`}
                >
                  {getGroupTaskStateLabel(panel.taskState)}
                </span>
              ) : null}
            </div>

            {isGroup && groupRoles.length > 0 ? (
              <div
                className={`mt-1 flex flex-wrap gap-1 text-[10px] ${bodyTextClass}`}
              >
                {groupRoles.map((role) => (
                  <span
                    key={role.id}
                    className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 ${softChipClass}`}
                  >
                    {role.emoji || "•"} {role.title}
                    {role.isLeader ? " ★" : ""}
                  </span>
                ))}
              </div>
            ) : !isGroup ? (
              <div
                className={`mt-1 text-xs ${bodyTextClass}`}
              >
                {agentLabel}
              </div>
            ) : null}

            <p
              className={`mt-2 line-clamp-2 text-xs leading-5 ${bodyTextClass}`}
            >
              {previewText}
            </p>
          </div>
        </div>
      </button>

      <button
        type="button"
        aria-label={isGroup ? `删除群组 ${panel.title}` : `删除角色 ${panel.title}`}
        title={isGroup ? "删除群组" : "删除角色"}
        onClick={onDelete}
        className={`absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold transition ${
          isActive
            ? "border-black/10 bg-white/72 text-[var(--ink-soft)] hover:border-red-300 hover:text-red-700"
            : "border-black/10 bg-[var(--paper)] text-[var(--ink-soft)] hover:border-red-300 hover:text-red-700"
        }`}
      >
        ×
      </button>
    </div>
  );
}
