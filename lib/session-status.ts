import type { MessageSessionMeta } from "@/lib/types";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as JsonRecord;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeModelName(value: unknown) {
  const raw = readString(value);
  if (!raw) {
    return null;
  }

  return raw.split("/").pop()?.trim() || raw;
}

export function extractMessageSessionMeta(input: {
  snapshot?: unknown;
}): MessageSessionMeta | null {
  const snapshot = asRecord(input.snapshot);
  if (!snapshot) {
    return null;
  }

  const snapshotRaw = asRecord(snapshot.raw);

  const model =
    normalizeModelName(snapshot.model) ??
    normalizeModelName(snapshotRaw?.model) ??
    normalizeModelName(snapshot.modelName) ??
    normalizeModelName(snapshotRaw?.modelName) ??
    normalizeModelName(snapshot.providerModel) ??
    normalizeModelName(snapshotRaw?.providerModel) ??
    normalizeModelName(snapshot.resolvedModel);

  const contextUsedTokens =
    readFiniteNumber(snapshot.totalTokens) ??
    readFiniteNumber(snapshotRaw?.totalTokens) ??
    readFiniteNumber(snapshot.totalTokenCount) ??
    readFiniteNumber(snapshotRaw?.totalTokenCount) ??
    null;
  const contextMaxTokens =
    readFiniteNumber(snapshot.contextTokens) ??
    readFiniteNumber(snapshotRaw?.contextTokens) ??
    readFiniteNumber(snapshot.contextWindow) ??
    readFiniteNumber(snapshotRaw?.contextWindow) ??
    readFiniteNumber(snapshot.contextLimit) ??
    readFiniteNumber(snapshotRaw?.contextLimit) ??
    null;
  const compactions =
    readFiniteNumber(snapshot.compactionCount) ??
    readFiniteNumber(snapshotRaw?.compactionCount) ??
    readFiniteNumber(snapshot.compactions) ??
    readFiniteNumber(snapshotRaw?.compactions) ??
    readFiniteNumber(snapshot.authProfileOverrideCompactionCount) ??
    readFiniteNumber(snapshotRaw?.authProfileOverrideCompactionCount) ??
    null;

  const contextPercent =
    contextUsedTokens != null && contextMaxTokens != null && contextMaxTokens > 0
      ? Math.max(0, Math.min(100, Math.round((contextUsedTokens / contextMaxTokens) * 100)))
      : null;

  if (
    model == null &&
    contextUsedTokens == null &&
    contextMaxTokens == null &&
    compactions == null
  ) {
    return null;
  }

  return {
    model,
    contextUsedTokens,
    contextMaxTokens,
    contextPercent,
    compactions,
  };
}
