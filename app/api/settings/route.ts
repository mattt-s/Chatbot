import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { readEffectiveAppSettings } from "@/lib/app-settings";
import { refreshBusyRoleWatchdog } from "@/lib/group-router";
import { invalidateLoggerConfig } from "@/lib/logger";
import { updateStoredAppSettings } from "@/lib/store";

const settingsSchema = z.object({
  appDebugEnabled: z.boolean(),
  groupRoleWatchdogIntervalMs: z.number().int().positive(),
  groupRoleBusyInspectAfterMs: z.number().int().positive(),
  groupRoleBusyAbortAfterMs: z.number().int().positive(),
});

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(await readEffectiveAppSettings());
}

export async function PUT(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const json = await request.json().catch(() => null);
  const parsed = settingsSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "参数错误。" }, { status: 400 });
  }

  await updateStoredAppSettings(parsed.data);
  invalidateLoggerConfig();
  refreshBusyRoleWatchdog();

  return NextResponse.json(await readEffectiveAppSettings());
}
