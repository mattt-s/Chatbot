import type { CustomChatGatewayApi } from "./api-types.js";
import {
  abortCustomChatSession,
  getCustomChatRuntimeStatus,
  inspectCustomChatSession,
} from "./plugin-runtime.js";

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export function registerCustomChatGatewayMethods(api: CustomChatGatewayApi) {
  if (typeof api.registerGatewayMethod !== "function") {
    return;
  }

  api.registerGatewayMethod("customchat.status", async ({ respond }) => {
    try {
      respond(true, await getCustomChatRuntimeStatus());
    } catch (error) {
      respond(false, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  api.registerGatewayMethod("customchat.session.inspect", async ({ params, respond }) => {
    try {
      const result = await inspectCustomChatSession({
        target: asString(params?.target),
        sessionKey: asString(params?.sessionKey),
        runId: asString(params?.runId),
        agentId: asString(params?.agentId),
        panelId: asString(params?.panelId),
      });
      respond(true, result);
    } catch (error) {
      respond(false, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  api.registerGatewayMethod("customchat.abort", async ({ params, respond }) => {
    try {
      const result = await abortCustomChatSession({
        target: asString(params?.target),
        sessionKey: asString(params?.sessionKey),
        runId: asString(params?.runId),
        agentId: asString(params?.agentId),
        panelId: asString(params?.panelId),
      });
      respond(true, result);
    } catch (error) {
      respond(false, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
