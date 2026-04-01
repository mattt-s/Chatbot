import fs from "node:fs";
import fsPromises from "node:fs/promises";

import { getDataFilePath, getEnv } from "@/lib/env";
import type { AppData, AppSettingsView, StoredAppSettings } from "@/lib/types";

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeStoredAppSettings(input: unknown): StoredAppSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const candidate = input as Record<string, unknown>;
  return {
    appDebugEnabled:
      typeof candidate.appDebugEnabled === "boolean"
        ? candidate.appDebugEnabled
        : undefined,
    groupRoleWatchdogIntervalMs: asPositiveInteger(candidate.groupRoleWatchdogIntervalMs),
    groupRoleBusyInspectAfterMs: asPositiveInteger(candidate.groupRoleBusyInspectAfterMs),
    groupRoleBusyAbortAfterMs: asPositiveInteger(candidate.groupRoleBusyAbortAfterMs),
    updatedAt:
      typeof candidate.updatedAt === "string" && candidate.updatedAt.trim()
        ? candidate.updatedAt.trim()
        : undefined,
  };
}

function readStoredAppSettingsFromData(data: AppData | null | undefined) {
  return normalizeStoredAppSettings(data?.settings);
}

function resolveEnvAppDebugEnabled() {
  const raw = process.env.APP_DEBUG?.trim().toLowerCase() ?? "";
  if (!raw || raw === "false" || raw === "0" || raw === "off" || raw === "no") {
    return false;
  }
  return true;
}

export function resolveEffectiveAppSettings(
  stored: StoredAppSettings | null | undefined,
): AppSettingsView {
  const env = getEnv();
  const normalized = normalizeStoredAppSettings(stored);

  return {
    appDebugEnabled:
      typeof normalized.appDebugEnabled === "boolean"
        ? normalized.appDebugEnabled
        : resolveEnvAppDebugEnabled(),
    groupRoleWatchdogIntervalMs:
      normalized.groupRoleWatchdogIntervalMs ?? env.groupRoleWatchdogIntervalMs,
    groupRoleBusyInspectAfterMs:
      normalized.groupRoleBusyInspectAfterMs ?? env.groupRoleBusyInspectAfterMs,
    groupRoleBusyAbortAfterMs:
      normalized.groupRoleBusyAbortAfterMs ?? env.groupRoleBusyAbortAfterMs,
  };
}

export function readStoredAppSettingsSync(): StoredAppSettings {
  try {
    if (!fs.existsSync(getDataFilePath())) {
      return {};
    }
    const raw = fs.readFileSync(getDataFilePath(), "utf8");
    const parsed = raw ? (JSON.parse(raw) as AppData) : null;
    return readStoredAppSettingsFromData(parsed);
  } catch {
    return {};
  }
}

export function readEffectiveAppSettingsSync(): AppSettingsView {
  return resolveEffectiveAppSettings(readStoredAppSettingsSync());
}

export async function readStoredAppSettings(): Promise<StoredAppSettings> {
  try {
    const raw = await fsPromises.readFile(getDataFilePath(), "utf8");
    const parsed = raw ? (JSON.parse(raw) as AppData) : null;
    return readStoredAppSettingsFromData(parsed);
  } catch {
    return {};
  }
}

export async function readEffectiveAppSettings(): Promise<AppSettingsView> {
  return resolveEffectiveAppSettings(await readStoredAppSettings());
}
