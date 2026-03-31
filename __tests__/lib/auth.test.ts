import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock "server-only"
vi.mock("server-only", () => ({}));

// Mock next/headers
const mockCookieStore = {
  get: vi.fn(),
  set: vi.fn(),
};
vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue(mockCookieStore),
}));

// Mock next/navigation
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn(),
  },
}));

// Mock env
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    sessionSecret: "test-secret-at-least-32-chars-long-for-hs256",
    cookieSecure: false,
  }),
}));

// Mock store
const mockFindUserByEmail = vi.fn();
const mockFindUserById = vi.fn();
vi.mock("@/lib/store", () => ({
  findUserByEmail: (...args: unknown[]) => mockFindUserByEmail(...args),
  findUserById: (...args: unknown[]) => mockFindUserById(...args),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createSessionToken", () => {
    it("creates a valid JWT string", async () => {
      const { createSessionToken } = await import("@/lib/auth");
      const token = await createSessionToken({
        id: "u1",
        email: "test@test.com",
        displayName: "Test",
      });
      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(3); // JWT has 3 parts
    });
  });

  describe("getCurrentUser", () => {
    it("returns null when no cookie", async () => {
      mockCookieStore.get.mockReturnValue(undefined);
      const { getCurrentUser } = await import("@/lib/auth");
      const user = await getCurrentUser();
      expect(user).toBeNull();
    });

    it("returns user when valid token", async () => {
      const { createSessionToken, getCurrentUser } = await import("@/lib/auth");
      const token = await createSessionToken({
        id: "u1",
        email: "test@test.com",
        displayName: "Test User",
      });
      mockCookieStore.get.mockReturnValue({ value: token });
      mockFindUserById.mockResolvedValue({
        id: "u1",
        email: "test@test.com",
        displayName: "Test User",
      });

      const user = await getCurrentUser();
      expect(user).not.toBeNull();
      expect(user!.id).toBe("u1");
      expect(user!.email).toBe("test@test.com");
    });

    it("returns null for invalid token", async () => {
      mockCookieStore.get.mockReturnValue({ value: "invalid-jwt" });
      const { getCurrentUser } = await import("@/lib/auth");
      const user = await getCurrentUser();
      expect(user).toBeNull();
    });

    it("returns null when user not found in store", async () => {
      const { createSessionToken, getCurrentUser } = await import("@/lib/auth");
      const token = await createSessionToken({
        id: "deleted-user",
        email: "gone@test.com",
        displayName: "Gone",
      });
      mockCookieStore.get.mockReturnValue({ value: token });
      mockFindUserById.mockResolvedValue(undefined);

      const user = await getCurrentUser();
      expect(user).toBeNull();
    });
  });

  describe("requireCurrentUser", () => {
    it("redirects to /login when no user", async () => {
      mockCookieStore.get.mockReturnValue(undefined);
      const { requireCurrentUser } = await import("@/lib/auth");
      await expect(requireCurrentUser()).rejects.toThrow("REDIRECT:/login");
    });
  });

  describe("authenticateUser", () => {
    it("returns null for unknown email", async () => {
      mockFindUserByEmail.mockResolvedValue(undefined);
      const { authenticateUser } = await import("@/lib/auth");
      const result = await authenticateUser("unknown@test.com", "pass");
      expect(result).toBeNull();
    });

    it("returns null for wrong password", async () => {
      const bcrypt = await import("bcryptjs");
      const hash = await bcrypt.default.hash("correct-password", 10);
      mockFindUserByEmail.mockResolvedValue({
        id: "u1",
        email: "admin@test.com",
        displayName: "Admin",
        passwordHash: hash,
      });
      const { authenticateUser } = await import("@/lib/auth");
      const result = await authenticateUser("admin@test.com", "wrong-password");
      expect(result).toBeNull();
    });

    it("returns user for correct password", async () => {
      const bcrypt = await import("bcryptjs");
      const hash = await bcrypt.default.hash("correct-password", 10);
      mockFindUserByEmail.mockResolvedValue({
        id: "u1",
        email: "admin@test.com",
        displayName: "Admin",
        passwordHash: hash,
      });
      const { authenticateUser } = await import("@/lib/auth");
      const result = await authenticateUser("admin@test.com", "correct-password");
      expect(result).not.toBeNull();
      expect(result!.id).toBe("u1");
      expect(result!.email).toBe("admin@test.com");
    });
  });
});
