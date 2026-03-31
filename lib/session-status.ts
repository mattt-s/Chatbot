import type { MessageSessionMeta } from "@/lib/types";

function readModelLine(statusText: string) {
  const match = /^\s*.*Model:\s*(.+?)(?:\s*·.*)?$/im.exec(statusText);
  const raw = match?.[1]?.trim();
  if (!raw) {
    return null;
  }

  return raw.split("/").pop()?.trim() || raw;
}

function parseCompactTokenCount(raw: string) {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  if (trimmed.endsWith("k")) {
    const base = Number(trimmed.slice(0, -1));
    return Number.isFinite(base) ? Math.round(base * 1000) : null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function extractMessageSessionMeta(input: {
  statusText?: string | null;
}): MessageSessionMeta | null {
  const statusText = input.statusText?.trim();
  if (!statusText) {
    return null;
  }

  const model = readModelLine(statusText);
  const contextMatch = /Context:\s*([0-9.]+k?)\/([0-9.]+k?)\s*\((\d+)%\)/i.exec(statusText);
  const compactionMatch = /Compactions:\s*(\d+)/i.exec(statusText);

  const contextUsedTokens = contextMatch ? parseCompactTokenCount(contextMatch[1] || "") : null;
  const contextMaxTokens = contextMatch ? parseCompactTokenCount(contextMatch[2] || "") : null;
  const contextPercent = contextMatch ? Number(contextMatch[3]) : null;
  const compactions = compactionMatch ? Number(compactionMatch[1]) : null;

  if (
    model == null &&
    contextUsedTokens == null &&
    contextMaxTokens == null &&
    contextPercent == null &&
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
