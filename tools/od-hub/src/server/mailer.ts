import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

/**
 * Minimal SMTP client for the invite mail (RFC 5321 + AUTH PLAIN/LOGIN +
 * STARTTLS). One message per connection, plain-text body only; no MIME
 * attachments, no pipelining. Enough to hand an invite URL to a relay you
 * operate — anything fancier belongs in the relay, not in the hub.
 *
 * `SMTP_URL` forms:
 *   smtp://host:25            plain, STARTTLS when the server offers it
 *   smtp://user:pass@host:587 AUTH after STARTTLS
 *   smtps://user:pass@host:465 implicit TLS
 */
export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

interface SmtpTarget {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
}

export function parseSmtpUrl(raw: string): SmtpTarget {
  const url = new URL(raw);
  if (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') throw new Error('SMTP_URL must use smtp:// or smtps://');
  const secure = url.protocol === 'smtps:';
  return {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : secure ? 465 : 25,
    secure,
    user: url.username ? decodeURIComponent(url.username) : null,
    pass: url.password ? decodeURIComponent(url.password) : null,
  };
}

/** Header values must be a single line; anything else is a header-injection vector. */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** RFC 5321 §4.5.2 dot-stuffing + CRLF normalisation for the DATA body. */
export function encodeBody(text: string): string {
  return text.replace(/\r?\n/g, '\r\n').split('\r\n').map((line) => (line.startsWith('.') ? `.${line}` : line)).join('\r\n');
}

export function buildMessage(message: MailMessage, date: Date = new Date()): string {
  const headers = [
    `From: ${headerSafe(message.from)}`,
    `To: ${headerSafe(message.to)}`,
    `Subject: ${headerSafe(message.subject)}`,
    `Date: ${date.toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${encodeBody(message.text)}`;
}

class SmtpConversation {
  private buffer = '';
  private waiters: Array<{ resolve: (lines: string[]) => void; reject: (error: Error) => void }> = [];
  private closed: Error | null = null;

  constructor(private socket: Socket) {
    this.attach(socket);
  }

  private attach(socket: Socket): void {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
    const fail = (error: Error) => {
      this.closed = error;
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    };
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('smtp connection closed')));
  }

  /** A reply is complete when a line reads `NNN ` (space, not dash). */
  private drain(): void {
    for (;;) {
      const lines = this.buffer.split('\r\n');
      const end = lines.findIndex((line) => /^\d{3}(?: |$)/.test(line));
      if (end === -1 || end === lines.length - 1 && !this.buffer.endsWith('\r\n')) return;
      const reply = lines.slice(0, end + 1);
      this.buffer = lines.slice(end + 1).join('\r\n');
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(reply);
    }
  }

  reply(): Promise<string[]> {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.drain();
    });
  }

  async command(line: string, expect: number[]): Promise<string[]> {
    this.socket.write(`${line}\r\n`);
    return this.expect(await this.reply(), expect, line.split(' ')[0]!);
  }

  expect(reply: string[], codes: number[], label: string): string[] {
    const code = Number.parseInt(reply[reply.length - 1]!.slice(0, 3), 10);
    if (!codes.includes(code)) throw new Error(`smtp ${label} failed: ${reply.join(' | ')}`);
    return reply;
  }

  /** Upgrade the transport in place after `220` to STARTTLS. */
  upgrade(host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tls = tlsConnect({ socket: this.socket, servername: host }, () => {
        this.socket = tls;
        this.buffer = '';
        this.attach(tls);
        resolve();
      });
      tls.once('error', reject);
    });
  }

  end(): void {
    this.socket.end();
  }
}

export function createSmtpMailer(rawUrl: string, options: { timeoutMs?: number; name?: string } = {}): Mailer {
  const target = parseSmtpUrl(rawUrl);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const clientName = options.name ?? 'od-hub.local';
  return {
    async send(message) {
      const socket: Socket = target.secure
        ? tlsConnect({ host: target.host, port: target.port, servername: target.host })
        : netConnect({ host: target.host, port: target.port });
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error('smtp timeout')));
      const smtp = new SmtpConversation(socket);
      try {
        smtp.expect(await smtp.reply(), [220], 'greeting');
        let ehlo = await smtp.command(`EHLO ${clientName}`, [250]);
        if (!target.secure && ehlo.some((line) => /STARTTLS/i.test(line))) {
          await smtp.command('STARTTLS', [220]);
          await smtp.upgrade(target.host);
          ehlo = await smtp.command(`EHLO ${clientName}`, [250]);
        }
        if (target.user !== null) {
          const mechanisms = ehlo.find((line) => /^250[- ]AUTH /i.test(line))?.slice(9).toUpperCase() ?? '';
          if (mechanisms.includes('PLAIN') || !mechanisms.includes('LOGIN')) {
            const token = Buffer.from(`\0${target.user}\0${target.pass ?? ''}`, 'utf8').toString('base64');
            await smtp.command(`AUTH PLAIN ${token}`, [235]);
          } else {
            await smtp.command('AUTH LOGIN', [334]);
            await smtp.command(Buffer.from(target.user, 'utf8').toString('base64'), [334]);
            await smtp.command(Buffer.from(target.pass ?? '', 'utf8').toString('base64'), [235]);
          }
        }
        await smtp.command(`MAIL FROM:<${addressOf(message.from)}>`, [250]);
        await smtp.command(`RCPT TO:<${addressOf(message.to)}>`, [250, 251]);
        await smtp.command('DATA', [354]);
        await smtp.command(`${buildMessage(message)}\r\n.`, [250]);
        await smtp.command('QUIT', [221]).catch(() => []);
      } finally {
        smtp.end();
      }
    },
  };
}

/** `Name <addr>` -> `addr`; bare addresses pass through. Angle brackets and CR/LF are stripped. */
export function addressOf(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match ? match[1]! : value).replace(/[\r\n<>\s]/g, '');
}
