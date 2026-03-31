import path from "node:path";

/**
 * 环境变量读取与路径工具模块。
 * 集中管理应用所需的所有环境变量，并提供存储目录的路径解析。
 */

const DEFAULT_DOWNLOAD_DIR_NAME = "downloads";
const DEFAULT_VOICE_DIR_NAME = "voice";
const DEFAULT_PROVIDER_INGRESS_PATH = "/customchat/inbound";

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

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value?.trim() || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 读取并返回所有应用环境变量配置。
 * 未设置的变量会使用合理的默认值。
 *
 * @returns {{ appBaseUrl: string, cookieSecure: boolean, sessionSecret: string, adminEmail: string, adminPassword: string, adminName: string, agentCatalogJson: string, providerBaseUrl: string, providerToken: string, providerIngressPath: string, customChatSharedSecret: string, customChatBridgeHost: string, customChatBridgePort: number, customChatBridgePath: string }} 环境变量配置对象
 */
export function getEnv() {
  const appBaseUrl = process.env.APP_BASE_URL ?? "http://127.0.0.1:3000";
  const cookieSecureFromEnv = parseBoolean(process.env.APP_COOKIE_SECURE);
  const customChatBridgePort = Number.parseInt(
    process.env.CUSTOMCHAT_APP_WS_PORT?.trim() || "3001",
    10,
  );

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
    providerBaseUrl: process.env.CUSTOMCHAT_PROVIDER_BASE_URL?.trim() || "",
    providerToken: process.env.CUSTOMCHAT_PROVIDER_TOKEN?.trim() || "",
    providerIngressPath:
      process.env.CUSTOMCHAT_PROVIDER_INGRESS_PATH?.trim() ||
      DEFAULT_PROVIDER_INGRESS_PATH,
    customChatSharedSecret:
      process.env.CUSTOMCHAT_SHARED_SECRET?.trim() || "",
    customChatBridgeHost:
      process.env.CUSTOMCHAT_APP_WS_HOST?.trim() || "127.0.0.1",
    customChatBridgePort:
      Number.isFinite(customChatBridgePort) && customChatBridgePort > 0
        ? customChatBridgePort
        : 3001,
    customChatBridgePath:
      process.env.CUSTOMCHAT_APP_WS_PATH?.trim() || "/api/customchat/socket",
    groupRoleWatchdogIntervalMs: parsePositiveInt(
      process.env.GROUP_ROLE_WATCHDOG_INTERVAL_MS,
      30_000,
    ),
    groupRoleBusyInspectAfterMs: parsePositiveInt(
      process.env.GROUP_ROLE_BUSY_INSPECT_AFTER_MS,
      5 * 60_000,
    ),
    groupRoleBusyAbortAfterMs: parsePositiveInt(
      process.env.GROUP_ROLE_BUSY_ABORT_AFTER_MS,
      10 * 60_000,
    ),
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
