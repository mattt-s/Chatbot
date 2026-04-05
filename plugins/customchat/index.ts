import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import type { CustomChatEntryApi } from "./api-types.js";
import { registerCustomChatBridgeService } from "./bridge-service.js";
import { customChatPlugin } from "./channel.js";
import { registerCustomChatGroupManagementTool } from "./group-management-tool.js";
import { registerCustomChatGroupPlanTool } from "./group-plan-tool.js";
import {
  CUSTOMCHAT_PLUGIN_DESCRIPTION,
  CUSTOMCHAT_PLUGIN_ID,
  CUSTOMCHAT_PLUGIN_NAME,
} from "./meta.js";

export { customChatPlugin } from "./channel.js";
export { activateLegacyCustomChat } from "./plugin-runtime.js";

export default defineChannelPluginEntry({
  id: CUSTOMCHAT_PLUGIN_ID,
  name: CUSTOMCHAT_PLUGIN_NAME,
  description: CUSTOMCHAT_PLUGIN_DESCRIPTION,
  plugin: customChatPlugin,
  registerFull(api: CustomChatEntryApi) {
    registerCustomChatBridgeService(api);
    registerCustomChatGroupManagementTool(api);
    registerCustomChatGroupPlanTool(api);
  },
});
