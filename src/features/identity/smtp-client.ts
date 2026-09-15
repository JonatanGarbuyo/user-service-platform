// Workers-native SMTP submission client (ticket #71, ADR-0001, ADR-0010).
//
// The previous Nodemailer transport used a Node `node:tls` STARTTLS path that
// the Cloudflare Workers runtime rejects
// (`startTls called with unsupported expectedServerHostname option`), so
// verification and password-reset mail never left the Worker. This module
// speaks SMTP directly over the Workers-native `cloudflare:sockets` TCP API:
// plaintext connect with `secureTransport: 'starttls'` plus an explicit
// `startTls()` upgrade for STARTTLS submission (typically port 587), or
// `secureTransport: 'on'` for implicit TLS (typically port 465).
//
// Provider neutrality is preserved: host, port, TLS mode, credentials and
// sender identity remain plain configuration; there are no provider-specific
// branches. TLS certificate verification stays mandatory: the runtime
// negotiates and verifies TLS and this module exposes no knob that disables
// it. Port 25 stays rejected at configuration time (`smtp-transport.ts`).
//
// Redaction (ADR-0009): errors carry the SMTP phase and numeric reply code
// only. Usernames, passwords, recipient addresses, action URLs, tokens and
// message bodies never enter error messages or logs.

export interface WorkersSmtpConfig {
  readonly host: string;
  readonly port: number;
  // True for implicit TLS, false for mandatory STARTTLS. Every supported mode
  // negotiates verified TLS; there is no plaintext mode.
  readonly secure: boolean;
  readonly user: string;
  readonly pass: string;
}

export interface WorkersSmtpEnvelope {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

// Narrow structural view of the `cloudflare:sockets` Socket surface used by
// the protocol session. Tests inject in-memory fakes through this shape;
// production passes the runtime socket through unchanged.
export interface WorkersSmtpSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  startTls(): WorkersSmtpSocket;
  close(): void;
}

export interface WorkersSmtpConnectOptions {
  readonly secureTransport: 'on' | 'off' | 'starttls';
}

export type WorkersSmtpConnect = (
  address: { hostname: string; port: number },
  options: WorkersSmtpConnectOptions,
) => WorkersSmtpSocket;

export interface WorkersSmtpDelivery {
  readonly config: WorkersSmtpConfig;
  readonly envelope: WorkersSmtpEnvelope;
  readonly connect: WorkersSmtpConnect;
  readonly heloName?: string;
}

const encoder = new TextEncoder();

// Marker for errors that are already redacted (phase + numeric code only).
// Anything else observed mid-delivery is wrapped in this type with a generic
// message so transport internals can never leak secrets.
export class SmtpDeliveryError extends Error {}

function toBase64Utf8(value: string): string {
  const bytes = encoder.encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function sanitizeHelo(value: string): string {
  const cleaned = sanitizeHeader(value);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/.test(cleaned)) {
    throw new SmtpDeliveryError('SMTP delivery failed during ehlo: invalid client hostname.');
  }
  return cleaned;
}

// RFC 2047 base64 subject encoding for non-ASCII subjects; plain ASCII
// subjects pass through unchanged.
function encodeSubject(subject: string): string {
  const cleaned = sanitizeHeader(subject);
  if (/^[\x20-\x7e]*$/.test(cleaned)) {
    return cleaned;
  }
  return `=?UTF-8?B?${toBase64Utf8(cleaned)}?=`;
}

function normalizeCrlf(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
}

// SMTP dot-stuffing (RFC 5321 4.5.2): lines beginning with a dot gain an
// extra dot so the DATA terminator `<CRLF>.<CRLF>` cannot appear in content.
function dotStuff(value: string): string {
  return value.replace(/(^|\r\n)\./g, '$1..');
}

// Extracts the envelope address from a display-name `From`/`To` header value
// such as `User Service <noreply@example.com>`; bare addresses pass through.
function extractEnvelopeAddress(value: string, field: 'from' | 'to'): string {
  const angled = /<([^<>\s@]+@[^<>\s@]+)>/.exec(value);
  const address = (angled?.[1] ?? value).trim();
  if (!/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(address)) {
    throw new SmtpDeliveryError(`SMTP delivery failed during envelope: invalid ${field} address.`);
  }
  return address;
}

function buildMultipartMessage(envelope: WorkersSmtpEnvelope, host: string): string {
  const boundary = `user-service-${crypto.randomUUID()}`;
  const headers = [
    `From: ${sanitizeHeader(envelope.from)}`,
    `To: ${sanitizeHeader(envelope.to)}`,
    `Subject: ${encodeSubject(envelope.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${sanitizeHeader(host)}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const textPart = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    dotStuff(normalizeCrlf(envelope.text)),
  ].join('\r\n');
  const htmlPart = [
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    dotStuff(normalizeCrlf(envelope.html)),
  ].join('\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${textPart}\r\n${htmlPart}\r\n--${boundary}--\r\n`;
}

interface ParsedReply {
  readonly code: number;
}

// Parses a complete server reply from the buffered text. Returns null while
// the final `<code><space>` line has not arrived yet, so split TCP chunks are
// reassembled before any reply is accepted (multiline `250-...` greetings
// included).
function parseCompleteReply(buffer: string): ParsedReply | null {
  if (!buffer.endsWith('\r\n')) {
    return null;
  }
  const lines = buffer.split('\r\n').filter((line) => line.length > 0);
  const last = lines.length > 0 ? (lines[lines.length - 1] ?? '') : '';
  const match = /^(\d{3}) /.exec(last);
  if (match === null) {
    return null;
  }
  return { code: Number(match[1]) };
}

class SmtpProtocolSession {
  private socket: WorkersSmtpSocket;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = '';
  private readonly textDecoder = new TextDecoder();

  constructor(socket: WorkersSmtpSocket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  async readReply(phase: string, expected: readonly number[]): Promise<void> {
    for (;;) {
      const read = await this.reader.read();
      if (read.done) {
        throw new SmtpDeliveryError(
          `SMTP delivery failed during ${phase}: connection closed unexpectedly.`,
        );
      }
      this.buffer += this.textDecoder.decode(read.value, { stream: true });
      const reply = parseCompleteReply(this.buffer);
      if (reply === null) {
        continue;
      }
      this.buffer = '';
      if (!expected.includes(reply.code)) {
        throw new SmtpDeliveryError(
          `SMTP delivery failed during ${phase}: reply code ${String(reply.code)}.`,
        );
      }
      return;
    }
  }

  async command(phase: string, text: string, expected: readonly number[]): Promise<void> {
    try {
      await this.writer.write(encoder.encode(`${text}\r\n`));
    } catch {
      throw new SmtpDeliveryError(`SMTP delivery failed during ${phase}: transport error.`);
    }
    await this.readReply(phase, expected);
  }

  async writeData(message: string): Promise<void> {
    try {
      await this.writer.write(encoder.encode(`${message}.\r\n`));
    } catch {
      throw new SmtpDeliveryError('SMTP delivery failed during message: transport error.');
    }
  }

  // Upgrades the STARTTLS plaintext connection to TLS. Existing readers and
  // writers stop working after `startTls()`, so locks are released first and
  // fresh ones are acquired from the returned secure socket.
  upgradeToTls(): void {
    this.reader.releaseLock();
    this.writer.releaseLock();
    this.socket = this.socket.startTls();
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    this.buffer = '';
  }

  async quit(): Promise<void> {
    try {
      await this.command('quit', 'QUIT', [221]);
    } catch {
      // Best effort: the delivery outcome is already decided.
    } finally {
      try {
        this.reader.releaseLock();
      } catch {
        // The reader may already be released after an upgrade race.
      }
      try {
        this.writer.releaseLock();
      } catch {
        // The writer may already be released after an upgrade race.
      }
      this.socket.close();
    }
  }

  closeWithoutQuit(): void {
    try {
      this.reader.releaseLock();
    } catch {
      // Already released; the socket close below still applies.
    }
    try {
      this.writer.releaseLock();
    } catch {
      // Already released; the socket close below still applies.
    }
    this.socket.close();
  }
}

// Delivers one message through the Workers-native SMTP conversation. The
// `connect` factory is the test seam: production passes the
// `cloudflare:sockets` runtime `connect`, tests inject an in-memory fake.
export async function deliverViaWorkersSmtp(
  delivery: WorkersSmtpDelivery,
): Promise<{ messageId?: string }> {
  const { config, envelope } = delivery;
  const helo = sanitizeHelo(delivery.heloName ?? 'user-service.local');
  const socket = delivery.connect(
    { hostname: config.host, port: config.port },
    { secureTransport: config.secure ? 'on' : 'starttls' },
  );
  const session = new SmtpProtocolSession(socket);
  try {
    await session.readReply('greeting', [220]);
    await session.command('ehlo', `EHLO ${helo}`, [250]);
    if (!config.secure) {
      await session.command('starttls', 'STARTTLS', [220]);
      session.upgradeToTls();
      await session.command('ehlo', `EHLO ${helo}`, [250]);
    }
    await session.command('auth', 'AUTH LOGIN', [334]);
    await session.command('username', toBase64Utf8(config.user), [334]);
    await session.command('password', toBase64Utf8(config.pass), [235]);
    await session.command(
      'mail-from',
      `MAIL FROM:<${extractEnvelopeAddress(envelope.from, 'from')}>`,
      [250],
    );
    await session.command(
      'rcpt-to',
      `RCPT TO:<${extractEnvelopeAddress(envelope.to, 'to')}>`,
      [250, 251],
    );
    await session.command('data', 'DATA', [354]);
    await session.writeData(buildMultipartMessage(envelope, config.host));
    await session.readReply('message', [250]);
    await session.quit();
    return {};
  } catch (error) {
    session.closeWithoutQuit();
    if (error instanceof SmtpDeliveryError) {
      throw error;
    }
    throw new SmtpDeliveryError('SMTP delivery failed: transport error.');
  }
}

async function loadRuntimeConnect(): Promise<WorkersSmtpConnect> {
  const runtime = await import('cloudflare:sockets');
  return (address, options) => runtime.connect(address, options);
}

// Builds the `SmtpSendMail` delivery seam from the Workers-native client. The
// runtime `connect` is resolved lazily inside the first send so importing this
// module never opens a connection and non-Workers test environments never
// touch the runtime module.
export function createWorkersSmtpSendMail(
  config: WorkersSmtpConfig,
  overrides?: { connect?: WorkersSmtpConnect; heloName?: string },
): (mail: WorkersSmtpEnvelope) => Promise<{ messageId?: string }> {
  return async (mail) => {
    const connect = overrides?.connect ?? (await loadRuntimeConnect());
    await deliverViaWorkersSmtp({
      config,
      envelope: mail,
      connect,
      heloName: overrides?.heloName,
    });
    return {};
  };
}
