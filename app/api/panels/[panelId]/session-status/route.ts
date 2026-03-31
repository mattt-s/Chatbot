import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { inspectProviderSession } from "@/lib/customchat-provider";
import { extractSessionStatusView } from "@/lib/session-status";
import { getPanelRecordForUser, listGroupRoles } from "@/lib/store";
import type { PanelSessionStatusResponse, SessionStatusView } from "@/lib/types";
import { toCustomChatGroupRoleTarget } from "@/lib/utils";

type RouteContext = {
  params: Promise<{ panelId: string }>;
};

async function readDirectSessionStatus(panelId: string, agentId: string) {
  const inspection = await inspectProviderSession({
    panelId,
    agentId,
    target: `channel:${panelId}`,
  });

  return extractSessionStatusView({
    sessionKey: inspection?.sessionKey ?? null,
    snapshot: inspection?.snapshot,
    source: inspection?.source === "runtime" || inspection?.source === "gateway-fallback"
      ? inspection.source
      : "unknown",
  });
}

async function readGroupRoleSessionStatuses(panelId: string) {
  const roles = await listGroupRoles(panelId);
  const entries = await Promise.all(
    roles
      .filter((role) => role.enabled)
      .map(async (role) => {
        const inspection = await inspectProviderSession({
          panelId,
          agentId: role.agentId,
          target: toCustomChatGroupRoleTarget(panelId, role.id),
        }).catch(() => null);

        const status = extractSessionStatusView({
          sessionKey: inspection?.sessionKey ?? null,
          snapshot: inspection?.snapshot,
          source: inspection?.source === "runtime" || inspection?.source === "gateway-fallback"
            ? inspection.source
            : "unknown",
        });

        return [role.id, status] as const;
      }),
  );

  return Object.fromEntries(entries) as Record<string, SessionStatusView | null>;
}

export async function GET(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { panelId } = await context.params;
  const panel = await getPanelRecordForUser(user.id, panelId);

  const payload: PanelSessionStatusResponse = {
    panelId,
    direct: null,
  };

  if (panel.kind === "group") {
    payload.groupRoles = await readGroupRoleSessionStatuses(panelId);
  } else {
    payload.direct = await readDirectSessionStatus(panelId, panel.agentId);
  }

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
