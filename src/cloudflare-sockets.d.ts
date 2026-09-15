// Type-only surface for the Workers TCP sockets runtime module
// (`cloudflare:sockets`) so the Node-side typecheck covers the SMTP client.
// At runtime the Worker provides the real module; this declaration only fills
// the compile-time gap and must stay minimal. Kept import-free so the file is
// a global script and the ambient module declaration always applies.
declare module 'cloudflare:sockets' {
  export interface SocketAddress {
    readonly hostname: string;
    readonly port: number;
  }

  export interface SocketOptions {
    readonly secureTransport?: 'on' | 'off' | 'starttls';
    readonly allowHalfOpen?: boolean;
  }

  export interface Socket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    startTls(): Socket;
    close(): void;
  }

  export function connect(address: SocketAddress, options?: SocketOptions): Socket;
}
