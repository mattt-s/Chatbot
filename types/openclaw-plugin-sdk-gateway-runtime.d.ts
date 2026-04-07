declare module "openclaw/plugin-sdk/gateway-runtime" {
  export type GatewayClientOptions = {
    url: string;
    token?: string;
    role?: string;
    scopes?: string[];
    mode?: string;
    clientName?: string;
    clientDisplayName?: string;
    clientVersion?: string;
    platform?: string;
    deviceFamily?: string;
    deviceIdentity?: {
      deviceId: string;
      publicKeyPem: string;
      privateKeyPem: string;
    };
    caps?: string[];
    connectChallengeTimeoutMs?: number;
    onHelloOk?: () => void;
    onConnectError?: (error: Error) => void;
    onClose?: (code: number, reason: string) => void;
    onEvent?: (frame: { event?: string; payload?: unknown }) => void;
  };

  export class GatewayClient {
    constructor(options: GatewayClientOptions);
    start(): void;
    stop(): void;
    request(
      method: string,
      params?: Record<string, unknown>,
      options?: { timeoutMs?: number },
    ): Promise<unknown>;
  }
}
