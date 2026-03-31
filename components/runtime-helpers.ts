/**
 * @file Runtime 步骤处理辅助函数。
 *
 * 解析和归一化 Gateway 返回的 runtime 步骤数据，将原始 JSON
 * 转换为可在消息气泡中展示的结构化信息（标题、描述、详情、状态）。
 * 支持识别 exec/write/read/edit/search/process 等多种工具调用类型。
 */
"use client";

import type { StoredRuntimeStep } from "@/lib/types";

/** Runtime 步骤类型别名 */
export type RuntimeStep = StoredRuntimeStep;

/** 对话列表条目（与 message-list 中的同名类型一致） */
export type ConversationItem = {
  id: string;
  ts: number;
  type: "message";
  message: import("@/lib/types").MessageView;
};

function truncateText(value: string, max = 180) {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function pickPathValue(data: Record<string, unknown>, path: string): unknown {
  let current: unknown = data;
  for (const key of path.split(".")) {
    const next = toRecord(current);
    if (!next || !(key in next)) {
      return null;
    }
    current = next[key];
  }
  return current;
}

function pickString(data: Record<string, unknown>, paths: string[]) {
  for (const path of paths) {
    const value = pickPathValue(data, path);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function pickNumber(data: Record<string, unknown>, paths: string[]) {
  for (const path of paths) {
    const value = pickPathValue(data, path);
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function pickStringArray(data: Record<string, unknown>, paths: string[]) {
  for (const path of paths) {
    const value = pickPathValue(data, path);
    if (!Array.isArray(value)) {
      continue;
    }

    const joined = value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .join(" ")
      .trim();
    if (joined) {
      return joined;
    }
  }
  return null;
}

function toReadableLabel(input: string) {
  return input
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectRuntimeKind(input: {
  stream: string;
  tool: string | null;
  summary: string | null;
  command: string | null;
}) {
  const raw = [input.stream, input.tool, input.summary, input.command]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/(exec|shell|command|pty|bash|zsh|npm |node |python|uv run|spawn|run )/.test(raw)) {
    return "exec" as const;
  }

  if (/(write|create|save|append|new file|file_write|write_file)/.test(raw)) {
    return "write" as const;
  }

  if (/(read|open|cat|view|load|file_read|read_file)/.test(raw)) {
    return "read" as const;
  }

  if (/(edit|patch|modify|update|replace|rewrite)/.test(raw)) {
    return "edit" as const;
  }

  if (/(search|find|grep|rg|query|lookup)/.test(raw)) {
    return "search" as const;
  }

  if (/(process|session|trail|pid|lifecycle|agent)/.test(raw)) {
    return "process" as const;
  }

  return "step" as const;
}

function formatCount(count: number | null) {
  if (typeof count !== "number") {
    return "";
  }

  return ` (${count} chars)`;
}

/**
 * 将 runtime 步骤的原始数据解析为可展示的结构化描述。
 *
 * 根据 stream 类型和数据字段，识别工具调用类型（exec/write/read/edit/search/process），
 * 提取标题、描述、详情文本和状态。
 *
 * @param stream - 事件流类型标识（如 "lifecycle"、"tool" 等）
 * @param data - 原始 runtime 步骤数据
 * @returns 包含 kind、title、description、detail、status 的描述对象
 */
export function describeRuntimeData(stream: string, data: Record<string, unknown>) {
  const phaseRaw = pickString(data, ["phase", "state", "status"]);
  const phase = phaseRaw?.toLowerCase() ?? null;
  const tool = pickString(data, ["tool", "name", "label", "type"]);
  const summary = pickString(data, ["summary", "message", "status", "result", "output"]);
  const result = pickString(data, ["result", "output", "stdout", "detail"]);
  const error = pickString(data, ["error", "errorMessage", "stderr"]);
  const command =
    pickString(data, ["command", "cmd", "shellCommand", "exec.command", "input.command"]) ??
    pickStringArray(data, ["args", "argv", "exec.args", "input.args"]);
  const cwd = pickString(data, ["cwd", "workdir", "workingDirectory", "exec.cwd", "input.cwd"]);
  const exitCode = pickNumber(data, ["exitCode", "code"]);
  const filePath = pickString(data, [
    "path",
    "file",
    "filename",
    "target",
    "uri",
    "location",
    "input.path",
    "output.path",
  ]);
  const count = pickNumber(data, ["chars", "charCount", "length", "size", "writtenChars"]);
  const processName = pickString(data, ["process", "session", "trail", "name", "id", "pid"]);
  const query = pickString(data, ["query", "keyword", "pattern", "needle"]);
  const kind = detectRuntimeKind({ stream, tool, summary, command });
  const isDone =
    exitCode === 0 ||
    phase === "end" ||
    phase === "done" ||
    phase === "success" ||
    phase === "completed";
  const isError = Boolean(error) || (typeof exitCode === "number" && exitCode !== 0);

  if (stream === "lifecycle" && phase === "start") {
    return {
      kind: "process" as const,
      title: "Process",
      description: "started",
      detail: null,
      status: "running" as const,
    };
  }

  if (stream === "lifecycle" && phase === "end") {
    return {
      kind: "process" as const,
      title: "Process",
      description: "completed",
      detail: null,
      status: "done" as const,
    };
  }

  if (kind === "exec") {
    const commandLine = command
      ? `Command: ${truncateText(command, 520)}${cwd ? ` (in ${cwd})` : ""}`
      : null;
    const outputLine = isError
      ? truncateText(error ?? `Exit code: ${exitCode}`, 480)
      : result
        ? truncateText(result, 480)
        : isDone
          ? "No output - tool completed successfully."
          : null;

    return {
      kind,
      title: "Exec",
      description: summary
        ? truncateText(summary, 320)
        : commandLine
          ? commandLine
          : "Command: (unknown)",
      detail: summary
        ? [commandLine, outputLine].filter(Boolean).join("\n\n") || null
        : outputLine,
      status: isError ? ("error" as const) : isDone ? ("done" as const) : ("running" as const),
    };
  }

  if (kind === "write") {
    return {
      kind,
      title: "Write",
      description: filePath
        ? `to ${truncateText(filePath, 300)}${formatCount(count)}`
        : summary
          ? truncateText(summary, 300)
          : "to file",
      detail: result ? truncateText(result, 420) : null,
      status: isError ? ("error" as const) : ("info" as const),
    };
  }

  if (kind === "read") {
    return {
      kind,
      title: "Read",
      description: filePath
        ? `from ${truncateText(filePath, 300)}`
        : summary
          ? truncateText(summary, 300)
          : "from file",
      detail: result ? truncateText(result, 420) : null,
      status: isError ? ("error" as const) : ("info" as const),
    };
  }

  if (kind === "edit") {
    return {
      kind,
      title: "Edit",
      description: filePath
        ? `in ${truncateText(filePath, 300)}${formatCount(count)}`
        : summary
          ? truncateText(summary, 300)
          : "edit content",
      detail: result ? truncateText(result, 420) : null,
      status: isError ? ("error" as const) : ("info" as const),
    };
  }

  if (kind === "search") {
    return {
      kind,
      title: "Search",
      description: query
        ? truncateText(query, 300)
        : summary
          ? truncateText(summary, 300)
          : "search",
      detail: result ? truncateText(result, 420) : null,
      status: isError ? ("error" as const) : isDone ? ("done" as const) : ("running" as const),
    };
  }

  if (kind === "process") {
    return {
      kind,
      title: "Process",
      description: processName
        ? truncateText(processName, 320)
        : summary
          ? truncateText(summary, 320)
          : toReadableLabel(stream) || "process update",
      detail: result ? truncateText(result, 420) : null,
      status: isError ? ("error" as const) : isDone ? ("done" as const) : ("info" as const),
    };
  }

  if (error) {
    return {
      kind: "step" as const,
      title: tool ? `Step: ${tool}` : "Step",
      description: truncateText(error),
      detail: summary ? truncateText(summary) : null,
      status: "error" as const,
    };
  }

  if (tool) {
    return {
      kind: "step" as const,
      title: "Step",
      description: summary
        ? `${truncateText(tool, 80)}: ${truncateText(summary, 320)}`
        : truncateText(tool, 320),
      detail: result ? truncateText(result) : null,
      status: "info" as const,
    };
  }

  return {
    kind: "step" as const,
    title: "Step",
    description: summary
      ? truncateText(summary)
      : toReadableLabel(stream) || "runtime update",
    detail: result ? truncateText(result) : null,
    status: "info" as const,
  };
}

/**
 * 判断 runtime 步骤是否为助手文本输出步骤。
 *
 * @param step - runtime 步骤
 * @returns 若为 assistant-text 类型返回 true
 */
export function isAssistantTextStep(step: RuntimeStep) {
  return step.stream === "assistant-text" || step.raw.type === "assistant-text";
}

/**
 * 判断 runtime 步骤是否应在 UI 中被忽略（不展示）。
 *
 * assistant 和 lifecycle 类型的步骤在气泡中不直接显示。
 *
 * @param step - runtime 步骤
 * @returns 若应忽略返回 true
 */
export function isIgnorableRuntimeStep(step: RuntimeStep) {
  const rawType = typeof step.raw.type === "string" ? step.raw.type : "";
  return (
    step.stream === "assistant" ||
    step.stream === "lifecycle" ||
    rawType === "assistant" ||
    rawType === "lifecycle"
  );
}

/**
 * 将 runtime 步骤归一化为适合 UI 展示的格式。
 *
 * 对非 assistant-text 步骤，调用 `describeRuntimeData` 解析并覆盖
 * kind/title/description/detail/status 字段。
 *
 * @param step - 原始 runtime 步骤
 * @returns 归一化后的 runtime 步骤副本
 */
export function normalizeRuntimeStepForDisplay(step: RuntimeStep): RuntimeStep {
  if (isAssistantTextStep(step)) {
    return step;
  }

  const described = describeRuntimeData(step.stream, step.raw);
  return {
    ...step,
    kind: described.kind,
    title: described.title,
    description: described.description,
    detail: described.detail,
    status: described.status,
  };
}

/**
 * 判断 runtime 步骤列表中是否包含 `message` 工具调用。
 *
 * 用于识别桥接投递消息——当 agent 使用 message tool 主动发送消息时，
 * 父级 run 的 runtimeSteps 中会包含 tool="message" 的步骤。
 *
 * @param steps - runtime 步骤数组
 * @returns 若包含 message 工具步骤返回 true
 */
export function hasMessageToolRuntimeStep(steps: RuntimeStep[]) {
  return steps.some((step) => {
    const rawTool = typeof step.raw.tool === "string" ? step.raw.tool : "";
    const rawName = typeof step.raw.name === "string" ? step.raw.name : "";
    return rawTool === "message" || rawName === "message";
  });
}
