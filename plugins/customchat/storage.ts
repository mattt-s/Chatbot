import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CUSTOMCHAT_STORAGE_ROOT =
  process.env.OPENCLAW_CUSTOMCHAT_STORAGE_ROOT?.trim() ||
  path.join(os.homedir(), ".openclaw", "channels", "customchat");

export async function ensureCustomChatStorageRoot() {
  await fs.mkdir(CUSTOMCHAT_STORAGE_ROOT, { recursive: true });
}

export async function readCustomChatJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeCustomChatJsonFile(filePath: string, payload: unknown) {
  await ensureCustomChatStorageRoot();
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}
