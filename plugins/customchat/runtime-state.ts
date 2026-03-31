import type { CustomChatEntryApi } from "./api-types.js";
import { initializeCustomChatRuntime } from "./plugin-runtime.js";

export function bootstrapCustomChatRuntime(api: CustomChatEntryApi) {
  initializeCustomChatRuntime(api);
}

export * from "./runtime-store.js";
export * from "./runtime-types.js";
