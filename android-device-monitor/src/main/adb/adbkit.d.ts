declare module 'adbkit' {
  export interface Device {
    id: string;
    type: string;
  }

  export interface AdbReadableStream extends NodeJS.ReadableStream {
    destroy(): void;
  }

  export interface Client {
    listDevices(): Promise<Device[]>;
    connect(target: string): Promise<void>;
    disconnect(target: string): Promise<void>;
    getProperties(deviceId: string): Promise<Record<string, string>>;
    shell(deviceId: string, command: string): Promise<AdbReadableStream>;
    openLogcat(deviceId: string): AdbReadableStream;
  }

  export function createClient(options?: {
    host?: string;
    port?: number;
  }): Client;
}