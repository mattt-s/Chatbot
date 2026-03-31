import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock "server-only"
vi.mock("server-only", () => ({}));

// Mock env
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    providerBaseUrl: "http://127.0.0.1:18789",
    providerToken: "test-token",
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("customchat-provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("deleteProviderSession", () => {
    it("sends DELETE request with correct auth", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
      });

      const { deleteProviderSession } = await import("@/lib/customchat-provider");
      await deleteProviderSession({ panelId: "p1", agentId: "main" });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:18789/customchat/session",
        expect.objectContaining({
          method: "DELETE",
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
        })
      );
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({ error: "not found" }),
      });

      const { deleteProviderSession } = await import("@/lib/customchat-provider");
      await expect(
        deleteProviderSession({ panelId: "p1", agentId: "main" })
      ).rejects.toThrow("not found");
    });
  });

  describe("abortProviderRun", () => {
    it("sends POST request with correct body", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, verified: true }),
      });

      const { abortProviderRun } = await import("@/lib/customchat-provider");
      const result = await abortProviderRun({
        panelId: "p1",
        agentId: "main",
        runId: "run-1",
        sessionKey: "panel:p1",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:18789/customchat/abort",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
        })
      );
      expect(result).toEqual({ ok: true, verified: true });
    });

    it("throws on failure", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: async () => ({ error: "abort failed" }),
      });

      const { abortProviderRun } = await import("@/lib/customchat-provider");
      await expect(
        abortProviderRun({ panelId: "p1", agentId: "main" })
      ).rejects.toThrow("abort failed");
    });
  });
});

describe("customchat-provider without config", () => {
  it("throws when providerBaseUrl is empty", async () => {
    vi.doMock("@/lib/env", () => ({
      getEnv: () => ({
        providerBaseUrl: "",
        providerToken: "token",
      }),
    }));

    // Reset module to pick up new mock
    vi.resetModules();
    vi.mock("server-only", () => ({}));
    const { deleteProviderSession } = await import("@/lib/customchat-provider");
    await expect(
      deleteProviderSession({ panelId: "p1", agentId: "main" })
    ).rejects.toThrow("CUSTOMCHAT_PROVIDER_BASE_URL");
  });
});
