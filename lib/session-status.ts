import type { SessionStatusView } from "@/lib/types";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function normalizeModelName(value: string | null) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const withoutProvider = trimmed.split("/").pop() ?? trimmed;
  return withoutProvider.trim() || null;
}

function extractFromStatusText(text: string) {
  const modelMatch = text.match(/🧠\s*Model:\s*([^\n·]+)/u);
  const contextMatch = text.match(/📚\s*Context:\s*(\d+(?:\.\d+)?k?)\/(\d+(?:\.\d+)?k?)\s*\((\d+)%\)/u);
  const compactionsMatch = text.match(/🧹\s*Compactions:\s*(\d+)/u);

  function parseCompactNumber(raw: string | undefined) {
    if (!raw) {
      return null;
    }

    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) {
      return null;
    }

    if (trimmed.endsWith("k")) {
      const numeric = Number(trimmed.slice(0, -1));
      return Number.isFinite(numeric) ? Math.round(numeric * 1000) : null;
    }

    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  }

  return {
    model: normalizeModelName(modelMatch?.[1]?.trim() ?? null),
    contextUsedTokens: parseCompactNumber(contextMatch?.[1]),
    contextMaxTokens: parseCompactNumber(contextMatch?.[2]),
    contextPercent:
      contextMatch?.[3] != null && Number.isFinite(Number(contextMatch[3]))
        ? Number(contextMatch[3])
        : null,
    compactions:
      compactionsMatch?.[1] != null && Number.isFinite(Number(compactionsMatch[1]))
        ? Number(compactionsMatch[1])
        : null,
  };
}

function firstString(value: unknown, keys: Set<string>, depth = 0): string | null {
  if (depth > 5 || value == null) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }

  if (typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = firstString(entry, keys, depth + 1);
      if (candidate) {
        return candidate;
      }
    }
    return null;
  }

  const record = value as JsonRecord;
  for (const [key, entry] of Object.entries(record)) {
    if (keys.has(key) && typeof entry === "string" && entry.trim()) {
      return entry.trim();
    }
  }

  for (const entry of Object.values(record)) {
    const candidate = firstString(entry, keys, depth + 1);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function firstNumber(value: unknown, keys: Set<string>, depth = 0): number | null {
  if (depth > 5 || value == null) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "object") {
    return null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = firstNumber(entry, keys, depth + 1);
      if (candidate != null) {
        return candidate;
      }
    }
    return null;
  }

  const record = value as JsonRecord;
  for (const [key, entry] of Object.entries(record)) {
    if (!keys.has(key)) {
      continue;
    }

    if (typeof entry === "number" && Number.isFinite(entry)) {
      return entry;
    }

    if (typeof entry === "string") {
      const numeric = Number(entry.trim());
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    }
  }

  for (const entry of Object.values(record)) {
    const candidate = firstNumber(entry, keys, depth + 1);
    if (candidate != null) {
      return candidate;
    }
  }

  return null;
}

export function extractSessionStatusView(input: {
  sessionKey?: string | null;
  snapshot?: unknown;
  source?: "runtime" | "gateway-fallback" | "unknown";
}): SessionStatusView | null {
  const snapshot = asRecord(input.snapshot);
  if (Object.keys(snapshot).length === 0) {
    return null;
  }

  const statusText =
    firstString(snapshot, new Set(["statusText", "status", "summary", "text", "detail"])) || null;
  const parsedStatusText = statusText ? extractFromStatusText(statusText) : null;

  const model =
    parsedStatusText?.model ??
    normalizeModelName(
      firstString(snapshot, new Set(["model", "modelName", "modelId", "providerModel", "resolvedModel"])),
    );
  const contextUsedTokens =
    parsedStatusText?.contextUsedTokens ??
    firstNumber(
      snapshot,
      new Set([
        "contextTokens",
        "contextUsedTokens",
        "usedContextTokens",
        "contextUsed",
        "promptTokens",
        "inputTokens",
      ]),
    );
  const contextMaxTokens =
    parsedStatusText?.contextMaxTokens ??
    firstNumber(
      snapshot,
      new Set([
        "contextWindow",
        "contextLimit",
        "contextMaxTokens",
        "maxContextTokens",
        "maxInputTokens",
        "modelContextWindow",
      ]),
    );
  const compactions =
    parsedStatusText?.compactions ??
    firstNumber(
      snapshot,
      new Set(["compactions", "compactionCount", "compactionsCount"]),
    );

  const contextPercent =
    parsedStatusText?.contextPercent ??
    (contextUsedTokens != null &&
    contextMaxTokens != null &&
    contextMaxTokens > 0
      ? Math.max(0, Math.min(100, Math.round((contextUsedTokens / contextMaxTokens) * 100)))
      : null);

  return {
    sessionKey:
      input.sessionKey?.trim() ||
      (typeof snapshot.key === "string" && snapshot.key.trim() ? snapshot.key.trim() : null),
    model,
    contextUsedTokens,
    contextMaxTokens,
    contextPercent,
    compactions,
    source: input.source ?? "unknown",
  };
}
