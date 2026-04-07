import path from "node:path";

/**
 * 环境变量读取与路径工具模块。
 * 集中管理应用所需的所有环境变量，并提供存储目录的路径解析。
 */

const DEFAULT_DOWNLOAD_DIR_NAME = "downloads";
const DEFAULT_VOICE_DIR_NAME = "voice";
const DEFAULT_CUSTOMCHAT_BRIDGE_HOST = "0.0.0.0";
const DEFAULT_CUSTOMCHAT_BRIDGE_PORT = 3001;
const DEFAULT_GROUP_ROLE_WATCHDOG_INTERVAL_MS = 30_000;
const DEFAULT_GROUP_ROLE_BUSY_INSPECT_AFTER_MS = 5 * 60_000;
const DEFAULT_GROUP_ROLE_BUSY_ABORT_AFTER_MS = 10 * 60_000;

function parseBoolean(value: string | undefined) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function parseInteger(value: string | undefined, fallback: number) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

/**
 * 读取并返回所有应用环境变量配置。
 * 未设置的变量会使用合理的默认值。
 *
 * @returns {{ appBaseUrl: string, cookieSecure: boolean, sessionSecret: string, adminEmail: string, adminPassword: string, adminName: string, agentCatalogJson: string, customChatAuthToken: string, customChatBridgePort: number, groupRoleWatchdogIntervalMs: number, groupRoleBusyInspectAfterMs: number, groupRoleBusyAbortAfterMs: number }} 环境变量配置对象
 */
export function getEnv() {
  const appBaseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:3000";
  const cookieSecureFromEnv = parseBoolean(process.env.APP_COOKIE_SECURE);

  return {
    appBaseUrl,
    cookieSecure:
      cookieSecureFromEnv ?? appBaseUrl.trim().toLowerCase().startsWith("https://"),
    sessionSecret:
      process.env.APP_SESSION_SECRET ?? "replace-me-with-a-long-random-secret",
    adminEmail: process.env.APP_ADMIN_EMAIL ?? "admin@example.com",
    adminPassword: process.env.APP_ADMIN_PASSWORD ?? "ChangeMe123!",
    adminName: process.env.APP_ADMIN_NAME ?? "Channel Admin",
    agentCatalogJson: process.env.APP_AGENT_CATALOG?.trim() || "",
    customChatAuthToken: process.env.CUSTOMCHAT_AUTH_TOKEN?.trim() || "",
    customChatBridgeHost:
      process.env.CUSTOMCHAT_BRIDGE_HOST?.trim() || DEFAULT_CUSTOMCHAT_BRIDGE_HOST,
    customChatBridgePort: parseInteger(
      process.env.CUSTOMCHAT_BRIDGE_PORT,
      DEFAULT_CUSTOMCHAT_BRIDGE_PORT,
    ),
    groupRoleWatchdogIntervalMs: DEFAULT_GROUP_ROLE_WATCHDOG_INTERVAL_MS,
    groupRoleBusyInspectAfterMs: DEFAULT_GROUP_ROLE_BUSY_INSPECT_AFTER_MS,
    groupRoleBusyAbortAfterMs: DEFAULT_GROUP_ROLE_BUSY_ABORT_AFTER_MS,
  };
}

/**
 * 获取存储根目录的绝对路径。
 * @returns {string} `{cwd}/storage`
 */
export function getStorageDir() {
  return path.join(process.cwd(), "storage");
}

/**
 * 获取用户上传文件的存储目录。
 * @returns {string} `{cwd}/storage/uploads`
 */
export function getUploadDir() {
  return path.join(getStorageDir(), "uploads");
}

/**
 * 获取下载文件的存储目录。
 * @returns {string} `{cwd}/storage/downloads`
 */
export function getDownloadDir() {
  return path.join(getStorageDir(), DEFAULT_DOWNLOAD_DIR_NAME);
}

/**
 * 获取语音文件的存储目录。
 * @returns {string} `{cwd}/storage/voice`
 */
export function getVoiceDir() {
  return path.join(getStorageDir(), DEFAULT_VOICE_DIR_NAME);
}

/**
 * 获取应用数据持久化文件的路径。
 * @returns {string} `{cwd}/storage/app-data.json`
 */
export function getDataFilePath() {
  return path.join(getStorageDir(), "app-data.json");
}
