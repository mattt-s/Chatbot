import type { IncomingMessage, ServerResponse } from "node:http";

export type CustomChatHttpRoute = {
  path: string;
  auth: "gateway" | "plugin";
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
};

export type CustomChatHttpRouteApi = {
  registerHttpRoute?: (route: CustomChatHttpRoute) => void;
};

export type CustomChatGatewayMethodContext = {
  params?: Record<string, unknown>;
  respond: (ok: boolean, payload?: unknown) => void;
};

export type CustomChatService = {
  id: string;
  start: () => void | Promise<void>;
};

export type CustomChatGatewayApi = {
  registerGatewayMethod?: (
    method: string,
    handler: (ctx: CustomChatGatewayMethodContext) => void | Promise<void>,
  ) => void;
  registerService?: (service: CustomChatService) => void;
};

export type CustomChatToolResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
  details?: unknown;
};

export type CustomChatToolDefinition = {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<CustomChatToolResult> | CustomChatToolResult;
};

export type CustomChatToolApi = {
  registerTool?: (
    tool: CustomChatToolDefinition,
    options?: {
      name?: string;
      names?: string[];
      optional?: boolean;
    },
  ) => void;
};

export type CustomChatLegacyActivateApi = CustomChatHttpRouteApi & {
  registerChannel: (channel: { plugin: unknown }) => void;
};

export type CustomChatEntryApi = CustomChatHttpRouteApi & CustomChatGatewayApi & CustomChatToolApi;
