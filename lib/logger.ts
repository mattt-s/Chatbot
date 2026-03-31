/**
 * 可配置的调试日志模块。
 *
 * 通过环境变量控制：
 *   APP_DEBUG=true           — 启用所有模块
 *   APP_DEBUG=auth,store     — 仅启用指定模块
 *   APP_DEBUG=false           — 禁用（默认）
 *   APP_DEBUG_LOG_FILE=./storage/debug.log  — 同时写入文件（可选）
 *
 * 使用方式：
 *   import { createLogger } from "@/lib/logger";
 *   const log = createLogger("store");
 *   log.debug("upsertAssistantMessage", { runId, text });
 *   log.error("upsertAssistantMessage", error, { runId });
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 模块级日志接口 */
export interface ModuleLogger {
  /** 记录调试信息：函数名 + 数据 */
  debug: (fn: string, data?: Record<string, unknown>) => void;
  /** 记录错误：函数名 + 错误对象 + 可选上下文 */
  error: (fn: string, err: unknown, data?: Record<string, unknown>) => void;
  /** 记录函数输入参数 */
  input: (fn: string, data: Record<string, unknown>) => void;
  /** 记录函数输出结果 */
  output: (fn: string, data: Record<string, unknown>) => void;
  /** 当前模块的调试是否启用 */
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Config (parsed once at module load, re-parseable for tests)
// ---------------------------------------------------------------------------

let _parsed = false;
let _enabledModules: Set<string> | "all" | null = null;
let _logFileFd: number | null = null;

function parseConfig() {
  if (_parsed) return;
  _parsed = true;

  const raw = process.env.APP_DEBUG?.trim().toLowerCase() ?? "";
  if (!raw || raw === "false" || raw === "0" || raw === "off" || raw === "no") {
    _enabledModules = null;
    return;
  }

  if (raw === "true" || raw === "1" || raw === "on" || raw === "yes" || raw === "*") {
    _enabledModules = "all";
  } else {
    _enabledModules = new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  }

  // Optional file output
  const logFile = process.env.APP_DEBUG_LOG_FILE?.trim();
  if (logFile) {
    try {
      const dir = path.dirname(logFile);
      fs.mkdirSync(dir, { recursive: true });
      _logFileFd = fs.openSync(logFile, "a");
    } catch {
      // Silently fall back to console only
    }
  }
}

function isModuleEnabled(module: string): boolean {
  parseConfig();
  if (_enabledModules === null) return false;
  if (_enabledModules === "all") return true;
  return _enabledModules.has(module.toLowerCase());
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function timestamp() {
  return new Date().toISOString();
}

function truncateValue(value: unknown, maxLen = 500): unknown {
  if (typeof value === "string" && value.length > maxLen) {
    return `${value.slice(0, maxLen)}... (${value.length} chars)`;
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return `<Buffer ${value.byteLength} bytes>`;
  }
  if (Array.isArray(value) && value.length > 20) {
    return `[Array(${value.length}) first 5: ${JSON.stringify(value.slice(0, 5))}]`;
  }
  return value;
}

function sanitizeData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    // Never log passwords or secrets
    if (/password|secret|token|hash/i.test(key)) {
      sanitized[key] = "***";
      continue;
    }
    sanitized[key] = truncateValue(value);
  }
  return sanitized;
}

function formatLine(
  level: string,
  module: string,
  fn: string,
  label: string,
  data?: Record<string, unknown>,
) {
  const ts = timestamp();
  const prefix = `${ts} [${level}] [app:${module}] ${fn}`;
  const body = data ? ` ${JSON.stringify(sanitizeData(data))}` : "";
  return `${prefix} ${label}${body}`;
}

function writeLine(line: string) {
  console.log(line);
  if (_logFileFd !== null) {
    try {
      fs.writeSync(_logFileFd, `${line}\n`);
    } catch {
      // Ignore write errors
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 为指定模块创建日志实例。若该模块未启用调试，返回空操作的 logger。
 *
 * @param {string} module - 模块名称，如 "store"、"auth"、"ingest"
 * @returns {ModuleLogger} 日志实例
 *
 * @example
 * const log = createLogger("store");
 * log.debug("upsertAssistantMessage", { runId });
 */
export function createLogger(module: string): ModuleLogger {
  const enabled = isModuleEnabled(module);

  if (!enabled) {
    const noop = () => {};
    return { debug: noop, error: noop, input: noop, output: noop, enabled: false };
  }

  return {
    enabled: true,
    debug(fn, data) {
      writeLine(formatLine("DEBUG", module, fn, "→", data));
    },
    error(fn, err, data) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : undefined;
      writeLine(
        formatLine("ERROR", module, fn, `✗ ${errMsg}`, {
          ...data,
          ...(errStack ? { stack: errStack } : {}),
        }),
      );
    },
    input(fn, data) {
      writeLine(formatLine("DEBUG", module, fn, "← input", data));
    },
    output(fn, data) {
      writeLine(formatLine("DEBUG", module, fn, "→ output", data));
    },
  };
}

/**
 * 重置内部状态（仅用于测试）。
 * 关闭已打开的日志文件并清除配置缓存。
 */
export function _resetLoggerForTests() {
  _parsed = false;
  _enabledModules = null;
  if (_logFileFd !== null) {
    try { fs.closeSync(_logFileFd); } catch { /* ignore */ }
    _logFileFd = null;
  }
}
