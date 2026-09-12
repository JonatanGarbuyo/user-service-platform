import type { Env } from '../../env.js';

// Application-owned transactional auth mail boundary (ADR-0010). Better Auth
// email callbacks adapt into these purpose-specific operations; provider SDK
// types never cross this interface. Template/branding inputs stay minimal so
// transports cannot observe business objects.
export interface VerificationMessage {
  readonly to: string;
  readonly url: string;
  readonly token: string;
  readonly expiresAt?: Date;
}

export interface PasswordResetMessage {
  readonly to: string;
  readonly url: string;
  readonly token: string;
  readonly expiresAt?: Date;
}

export interface AuthMailer {
  sendVerificationEmail(message: VerificationMessage): Promise<void>;
  sendPasswordResetEmail(message: PasswordResetMessage): Promise<void>;
}

interface CapturedMessage extends VerificationMessage {
  readonly capturedAt: string;
}

// In-memory AuthMailer for Workers-runtime tests. Captured actions are
// readable only inside the isolated test process; verification and
// password-reset URLs and tokens never reach logs, events, or error payloads
// through this transport.
export class InMemoryAuthMailer implements AuthMailer {
  private readonly messages: CapturedMessage[] = [];
  private readonly resetMessages: CapturedMessage[] = [];

  get sent(): readonly CapturedMessage[] {
    return this.messages;
  }

  get passwordResets(): readonly CapturedMessage[] {
    return this.resetMessages;
  }

  sendVerificationEmail(message: VerificationMessage): Promise<void> {
    this.messages.push({ ...message, capturedAt: new Date().toISOString() });
    return Promise.resolve();
  }

  sendPasswordResetEmail(message: PasswordResetMessage): Promise<void> {
    this.resetMessages.push({ ...message, capturedAt: new Date().toISOString() });
    return Promise.resolve();
  }

  clear(): void {
    this.messages.length = 0;
    this.resetMessages.length = 0;
  }
}

// Local development sink: records only operational metadata (recipient domain
// and purpose) so verification and password-reset flows can be exercised
// without credentials or network delivery. Bodies, tokens and action URLs are
// never logged.
export class DevelopmentAuthMailer implements AuthMailer {
  sendVerificationEmail(message: VerificationMessage): Promise<void> {
    const domain = message.to.split('@')[1] ?? 'invalid';
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'auth-mail.scheduled',
        purpose: 'email-verification',
        recipientDomain: domain,
      }),
    );
    return Promise.resolve();
  }

  sendPasswordResetEmail(message: PasswordResetMessage): Promise<void> {
    const domain = message.to.split('@')[1] ?? 'invalid';
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'auth-mail.scheduled',
        purpose: 'password-reset',
        recipientDomain: domain,
      }),
    );
    return Promise.resolve();
  }
}

// Resolves the mailer for the current environment. Tests inject an
// InMemoryAuthMailer explicitly; staging/production fail closed until the
// production transport lands (ticket #13) rather than silently dropping mail.
export function resolveAuthMailer(
  env: Pick<Env, 'ENVIRONMENT' | 'AUTH_MAIL_TRANSPORT'>,
  override?: AuthMailer,
): AuthMailer {
  if (override !== undefined) {
    return override;
  }
  if (env.AUTH_MAIL_TRANSPORT === 'inmemory') {
    return new InMemoryAuthMailer();
  }
  const environment = env.ENVIRONMENT ?? 'local';
  if (environment === 'staging' || environment === 'production') {
    throw new Error(
      `No transactional mail transport is configured for ${environment}; refusing to start auth flows without one (ticket #13).`,
    );
  }
  return new DevelopmentAuthMailer();
}
