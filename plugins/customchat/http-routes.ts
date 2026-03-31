import type { CustomChatHttpRouteApi } from "./api-types.js";
import { registerCustomChatHttpRoutes } from "./plugin-runtime.js";

export function registerCustomChatBridgeRoutes(api: CustomChatHttpRouteApi) {
  registerCustomChatHttpRoutes(api);
}

