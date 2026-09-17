import { describe, expect, it } from 'vitest';
import {
  createWorkersSmtpSendMail,
  deliverViaWorkersSmtp,
  SmtpDeliveryError,
  type WorkersSmtpConnect,
  type WorkersSmtpEnvelope,
} from './smtp-client.js';

// Seam under test (ticket #71, ADR-0010): the Workers-native SMTP
// protocol/TLS conversation. The `connect` factory is injected so these tests
// prove EHLO/STARTTLS/AUTH/MAIL/RCPT/DATA sequencing, TLS-upgrade selection
// and redaction without live delivery, credentials or network calls.

const ENVELOPE: WorkersSmtpEnvelope = {
  from: 'User Service <noreply@example.com>',
  to: 'ada@example.com',
  subject: 'Verify your User Service email',
  text: 'Open this link: https://example.com/verify?token=secret-token',
  html: '<p>Open <a href="https://example.com/verify?token=secret-token">this link</a></p>',
};

interface ScriptedStep {
  readonly expectPrefix?: string;
  readonly respond: string;
}

interface FakeSocketState {
  readonly written: string[];
  readonly upgraded: { value: boolean };
  readonly closed: { value: boolean };
}

// Builds an in-memory `cloudflare:sockets`-shaped fake. The script lists the
// server replies in order: the first entry is the greeting, then one reply per
// expected client command. Writes are captured for sequencing assertions and
// the shared cursor advances across the STARTTLS upgrade, mirroring how the
// runtime replaces the socket while the conversation continues.
function fakeConnect(script: ScriptedStep[]): {
  connect: WorkersSmtpConnect;
  calls: { address: { hostname: string; port: number }; secureTransport: string }[];
  state: FakeSocketState;
} {
  const calls: { address: { hostname: string; port: number }; secureTransport: string }[] = [];
  const written: string[] = [];
  const upgraded = { value: false };
  const closed = { value: false };
  let cursor = 0;

  const nextReply = (): string => {
    const step = script[cursor];
    cursor += 1;
    if (step === undefined) {
      throw new Error('Fake SMTP server received more reads than scripted replies.');
    }
    return step.respond;
  };

  const makeSocket = (): ReturnType<WorkersSmtpConnect> => {
    const socket: ReturnType<WorkersSmtpConnect> = {
      readable: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode(nextReply()));
        },
      }),
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(new TextDecoder().decode(chunk));
        },
      }),
      startTls() {
        upgraded.value = true;
        return makeSocket();
      },
      close() {
        closed.value = true;
      },
    };
    return socket;
  };

  const connect: WorkersSmtpConnect = (address, options) => {
    calls.push({ address, secureTransport: options.secureTransport });
    return makeSocket();
  };

  return { connect, calls, state: { written, upgraded, closed } };
}

function greetingThen(...replies: string[]): ScriptedStep[] {
  return [
    { respond: '220 smtp.example.com ESMTP ready\r\n' },
    ...replies.map((respond) => ({ respond })),
  ];
}

describe('deliverViaWorkersSmtp STARTTLS path', () => {
  it('performs mandatory STARTTLS before AUTH on port 587', async () => {
    const script = greetingThen(
      '250-smtp.example.com greets worker\r\n250 8BITMIME\r\n',
      '220 2.0.0 Ready to start TLS\r\n',
      '250-smtp.example.com greets worker\r\n250 AUTH LOGIN PLAIN\r\n',
      '334 VXNlcm5hbWU6\r\n',
      '334 UGFzc3dvcmQ6\r\n',
      '235 2.7.0 Authentication successful\r\n',
      '250 2.1.0 Sender OK\r\n',
      '250 2.1.5 Recipient OK\r\n',
      '354 End data with <CR><LF>.<CR><LF>\r\n',
      '250 2.0.0 Message queued\r\n',
      '221 2.0.0 Bye\r\n',
    );
    const { connect, calls, state } = fakeConnect(script);

    await deliverViaWorkersSmtp({
      config: { host: 'smtp.example.com', port: 587, secure: false, user: 'mailer', pass: 'pw' },
      envelope: ENVELOPE,
      connect,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.address).toEqual({ hostname: 'smtp.example.com', port: 587 });
    expect(calls[0]?.secureTransport).toBe('starttls');
    expect(state.upgraded.value).toBe(true);
    const transcript = state.written.join('');
    expect(transcript).toContain('EHLO ');
    expect(transcript).toContain('STARTTLS\r\n');
    expect(transcript).toContain('AUTH LOGIN\r\n');
    // AUTH LOGIN exchanges the base64 username then password.
    expect(transcript).toContain(`${btoa('mailer')}\r\n`);
    expect(transcript).toContain(`${btoa('pw')}\r\n`);
    expect(transcript).toContain('MAIL FROM:<noreply@example.com>\r\n');
    expect(transcript).toContain('RCPT TO:<ada@example.com>\r\n');
    expect(transcript).toContain('DATA\r\n');
    expect(transcript).toContain('QUIT\r\n');
  });

  it('delivers a multipart message carrying both text and html bodies', async () => {
    const script = greetingThen(
      '250-smtp.example.com greets worker\r\n250 8BITMIME\r\n',
      '220 2.0.0 Ready to start TLS\r\n',
      '250-smtp.example.com greets worker\r\n250 AUTH LOGIN PLAIN\r\n',
      '334 VXNlcm5hbWU6\r\n',
      '334 UGFzc3dvcmQ6\r\n',
      '235 2.7.0 Authentication successful\r\n',
      '250 2.1.0 Sender OK\r\n',
      '250 2.1.5 Recipient OK\r\n',
      '354 End data with <CR><LF>.<CR><LF>\r\n',
      '250 2.0.0 Message queued\r\n',
      '221 2.0.0 Bye\r\n',
    );
    const { connect, state } = fakeConnect(script);

    await deliverViaWorkersSmtp({
      config: { host: 'smtp.example.com', port: 587, secure: false, user: 'mailer', pass: 'pw' },
      envelope: ENVELOPE,
      connect,
    });

    const data = state.written.join('');
    expect(data).toContain('multipart/alternative');
    expect(data).toContain('Open this link: https://example.com/verify?token=secret-token');
    expect(data).toContain('<a href="https://example.com/verify?token=secret-token">');
    expect(data).toContain('\r\n.\r\n');
  });
});

describe('deliverViaWorkersSmtp implicit TLS path', () => {
  it('connects with implicit TLS and skips STARTTLS on port 465', async () => {
    const script = greetingThen(
      '250-smtp.example.com greets worker\r\n250 AUTH LOGIN PLAIN\r\n',
      '334 VXNlcm5hbWU6\r\n',
      '334 UGFzc3dvcmQ6\r\n',
      '235 2.7.0 Authentication successful\r\n',
      '250 2.1.0 Sender OK\r\n',
      '250 2.1.5 Recipient OK\r\n',
      '354 End data with <CR><LF>.<CR><LF>\r\n',
      '250 2.0.0 Message queued\r\n',
      '221 2.0.0 Bye\r\n',
    );
    const { connect, calls, state } = fakeConnect(script);

    await deliverViaWorkersSmtp({
      config: { host: 'smtp.example.com', port: 465, secure: true, user: 'mailer', pass: 'pw' },
      envelope: ENVELOPE,
      connect,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.secureTransport).toBe('on');
    expect(state.upgraded.value).toBe(false);
    const transcript = state.written.join('');
    expect(transcript).not.toContain('STARTTLS');
    expect(transcript).toContain('AUTH LOGIN\r\n');
    expect(transcript).toContain('MAIL FROM:<noreply@example.com>\r\n');
  });
});

describe('createWorkersSmtpSendMail', () => {
  it('delivers through the injected Workers socket factory', async () => {
    const script = greetingThen(
      '250-smtp.example.com greets worker\r\n250 8BITMIME\r\n',
      '220 2.0.0 Ready to start TLS\r\n',
      '250-smtp.example.com greets worker\r\n250 AUTH LOGIN PLAIN\r\n',
      '334 VXNlcm5hbWU6\r\n',
      '334 UGFzc3dvcmQ6\r\n',
      '235 2.7.0 Authentication successful\r\n',
      '250 2.1.0 Sender OK\r\n',
      '250 2.1.5 Recipient OK\r\n',
      '354 End data with <CR><LF>.<CR><LF>\r\n',
      '250 2.0.0 Message queued\r\n',
      '221 2.0.0 Bye\r\n',
    );
    const { connect, calls, state } = fakeConnect(script);

    const send = createWorkersSmtpSendMail(
      { host: 'smtp.example.com', port: 587, secure: false, user: 'mailer', pass: 'pw' },
      { connect },
    );
    const result = await send(ENVELOPE);

    expect(result).toEqual({});
    expect(calls).toHaveLength(1);
    expect(calls[0]?.secureTransport).toBe('starttls');
    expect(state.written.join('')).toContain('MAIL FROM:<noreply@example.com>\r\n');
  });
});

describe('deliverViaWorkersSmtp failure redaction', () => {
  it('rejects with a redacted error when authentication fails', async () => {
    const script = greetingThen(
      '250-smtp.example.com greets worker\r\n250 8BITMIME\r\n',
      '220 2.0.0 Ready to start TLS\r\n',
      '250-smtp.example.com greets worker\r\n250 AUTH LOGIN PLAIN\r\n',
      '334 VXNlcm5hbWU6\r\n',
      '334 UGFzc3dvcmQ6\r\n',
      '535 5.7.8 Authentication credentials invalid\r\n',
    );
    const { connect } = fakeConnect(script);

    const failure = await deliverViaWorkersSmtp({
      config: {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: 'mailer@example.com',
        pass: 's3cret-password-do-not-use',
      },
      envelope: ENVELOPE,
      connect,
    }).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(failure).not.toBeNull();
    expect(failure ?? '').toContain('535');
    expect(failure ?? '').not.toContain('s3cret-password-do-not-use');
    expect(failure ?? '').not.toContain('mailer@example.com');
    expect(failure ?? '').not.toContain('secret-token');
    expect(failure ?? '').not.toContain('ada@example.com');
  });

  it('exposes the typed SMTP phase and reply code on AUTH failure', async () => {
    const script = greetingThen(
      '250-smtp.example.com greets worker\r\n250 8BITMIME\r\n',
      '220 2.0.0 Ready to start TLS\r\n',
      '250-smtp.example.com greets worker\r\n250 AUTH LOGIN PLAIN\r\n',
      '334 VXNlcm5hbWU6\r\n',
      '334 UGFzc3dvcmQ6\r\n',
      '535 5.7.8 Authentication credentials invalid\r\n',
    );
    const { connect } = fakeConnect(script);

    const failure = await deliverViaWorkersSmtp({
      config: {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: 'mailer@example.com',
        pass: 's3cret-password-do-not-use',
      },
      envelope: ENVELOPE,
      connect,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SmtpDeliveryError);
    const deliveryError = failure as SmtpDeliveryError;
    expect(deliveryError.phase).toBe('password');
    expect(deliveryError.replyCode).toBe(535);
    expect(deliveryError.message).toContain('535');
    expect(deliveryError.message).not.toContain('s3cret-password-do-not-use');
    expect(deliveryError.message).not.toContain('mailer@example.com');
  });

  it('exposes a transport phase without a reply code when the greeting closes', async () => {
    const { connect } = fakeConnect([]);
    const closedConnect: WorkersSmtpConnect = (address, options) => {
      const socket = connect(address, options);
      return {
        ...socket,
        readable: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
      };
    };

    const failure = await deliverViaWorkersSmtp({
      config: {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: 'mailer@example.com',
        pass: 's3cret-password-do-not-use',
      },
      envelope: ENVELOPE,
      connect: closedConnect,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SmtpDeliveryError);
    const deliveryError = failure as SmtpDeliveryError;
    expect(deliveryError.phase).toBe('greeting');
    expect(deliveryError.replyCode).toBeUndefined();
    expect(deliveryError.message).not.toContain('s3cret-password-do-not-use');
    expect(deliveryError.message).not.toContain('mailer@example.com');
    expect(deliveryError.message).not.toContain('ada@example.com');
  });

  it('dot-stuffs body lines that begin with a dot', async () => {
    const script = greetingThen(
      '250-smtp.example.com greets worker\r\n250 8BITMIME\r\n',
      '220 2.0.0 Ready to start TLS\r\n',
      '250-smtp.example.com greets worker\r\n250 AUTH LOGIN PLAIN\r\n',
      '334 VXNlcm5hbWU6\r\n',
      '334 UGFzc3dvcmQ6\r\n',
      '235 2.7.0 Authentication successful\r\n',
      '250 2.1.0 Sender OK\r\n',
      '250 2.1.5 Recipient OK\r\n',
      '354 End data with <CR><LF>.<CR><LF>\r\n',
      '250 2.0.0 Message queued\r\n',
      '221 2.0.0 Bye\r\n',
    );
    const { connect, state } = fakeConnect(script);

    await deliverViaWorkersSmtp({
      config: { host: 'smtp.example.com', port: 587, secure: false, user: 'mailer', pass: 'pw' },
      envelope: { ...ENVELOPE, text: 'first\n.tricky\nlast' },
      connect,
    });

    expect(state.written.join('')).toContain('\n..tricky');
  });
});
