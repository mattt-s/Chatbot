declare module "openclaw/plugin-sdk/core" {
  export function defineChannelPluginEntry<T extends object>(entry: T): T;
}

