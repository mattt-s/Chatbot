import type { CustomChatEntryApi } from "./api-types.js";
import { registerCustomChatGatewayMethods } from "./gateway-methods.js";
import { registerCustomChatBridgeRoutes } from "./http-routes.js";
import { bootstrapCustomChatRuntime } from "./runtime-state.js";

let customChatBridgeServiceRegistered = false;

export function registerCustomChatBridgeService(api: CustomChatEntryApi) {
  registerCustomChatBridgeRoutes(api);
  registerCustomChatGatewayMethods(api);

  if (typeof api.registerService === "function" && !customChatBridgeServiceRegistered) {
    customChatBridgeServiceRegistered = true;
    api.registerService({
      id: "customchat-bridge",
      start: async () => {
        bootstrapCustomChatRuntime(api);
      },
    });
    return;
  }

  bootstrapCustomChatRuntime(api);
}
