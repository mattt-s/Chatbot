import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("getEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset module cache so getEnv reads fresh env vars
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns defaults when no env vars set", async () => {
    delete process.env.APP_BASE_URL;
    delete process.env.APP_SESSION_SECRET;
    delete process.env.APP_ADMIN_EMAIL;
    delete process.env.APP_ADMIN_PASSWORD;
    delete process.env.APP_ADMIN_NAME;
    delete process.env.CUSTOMCHAT_PROVIDER_BASE_URL;
    delete process.env.CUSTOMCHAT_PROVIDER_TOKEN;
    delete process.env.CUSTOMCHAT_APP_WS_PORT;
    delete process.env.CUSTOMCHAT_APP_WS_HOST;
    delete process.env.CUSTOMCHAT_APP_WS_PATH;

    const { getEnv } = await import("@/lib/env");
    const env = getEnv();
    expect(env.appBaseUrl).toBe("http://127.0.0.1:3000");
    expect(env.cookieSecure).toBe(false);
    expect(env.adminEmail).toBe("admin@example.com");
    expect(env.adminPassword).toBe("ChangeMe123!");
    expect(env.adminName).toBe("Channel Admin");
    expect(env.customChatBridgeHost).toBe("127.0.0.1");
    expect(env.customChatBridgePort).toBe(3001);
    expect(env.customChatBridgePath).toBe("/api/customchat/socket");
    expect(env.providerIngressPath).toBe("/customchat/inbound");
  });

  it("reads APP_BASE_URL", async () => {
    process.env.APP_BASE_URL = "https://chat.example.com";
    const { getEnv } = await import("@/lib/env");
    const env = getEnv();
    expect(env.appBaseUrl).toBe("https://chat.example.com");
    expect(env.cookieSecure).toBe(true);
  });

  it("parses APP_COOKIE_SECURE override", async () => {
    process.env.APP_BASE_URL = "https://chat.example.com";
    process.env.APP_COOKIE_SECURE = "false";
    const { getEnv } = await import("@/lib/env");
    const env = getEnv();
    expect(env.cookieSecure).toBe(false);
  });

  it("parses custom WS port", async () => {
    process.env.CUSTOMCHAT_APP_WS_PORT = "4001";
    const { getEnv } = await import("@/lib/env");
    expect(getEnv().customChatBridgePort).toBe(4001);
  });

  it("falls back to 3001 for invalid WS port", async () => {
    process.env.CUSTOMCHAT_APP_WS_PORT = "not-a-number";
    const { getEnv } = await import("@/lib/env");
    expect(getEnv().customChatBridgePort).toBe(3001);
  });
});

describe("getStorageDir / getUploadDir / getDownloadDir / getDataFilePath", () => {
  it("returns paths under cwd/storage", async () => {
    const { getStorageDir, getUploadDir, getDownloadDir, getDataFilePath } = await import("@/lib/env");
    const cwd = process.cwd();
    expect(getStorageDir()).toBe(`${cwd}/storage`);
    expect(getUploadDir()).toBe(`${cwd}/storage/uploads`);
    expect(getDownloadDir()).toBe(`${cwd}/storage/downloads`);
    expect(getDataFilePath()).toBe(`${cwd}/storage/app-data.json`);
  });
});
