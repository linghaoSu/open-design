import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { addressOf, buildMessage, createSmtpMailer, encodeBody, parseSmtpUrl } from '../src/server/mailer.js';

/**
 * Minimal SMTP fake: greets, answers EHLO with AUTH PLAIN, accepts one message.
 * Records the DATA block so the test can assert the exact bytes on the wire.
 */
class FakeSmtp {
  server: Server | null = null;
  readonly commands: string[] = [];
  data = '';
  authenticated: string | null = null;
  requireAuth = false;

  async start(): Promise<string> {
    this.server = createServer((socket) => this.serve(socket));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private serve(socket: Socket): void {
    let buffer = '';
    let inData = false;
    socket.write('220 fake.smtp ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          this.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 2.0.0 queued\r\n');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        this.commands.push(line);
        const verb = line.split(' ')[0]!.toUpperCase();
        if (verb === 'EHLO') socket.write('250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (verb === 'AUTH') {
          const [, mech, token] = line.split(' ');
          if (mech!.toUpperCase() === 'PLAIN' && token) {
            const [, user, pass] = Buffer.from(token, 'base64').toString('utf8').split('\0');
            if (pass === 'secret') { this.authenticated = user!; socket.write('235 ok\r\n'); } else socket.write('535 bad\r\n');
          } else socket.write('504 unsupported\r\n');
        } else if (verb === 'MAIL' || verb === 'RCPT') {
          if (this.requireAuth && !this.authenticated) socket.write('530 auth required\r\n');
          else socket.write('250 ok\r\n');
        } else if (verb === 'DATA') { inData = true; socket.write('354 go\r\n'); }
        else if (verb === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('500 what\r\n');
      }
    });
  }
}

describe('mailer helpers', () => {
  it('parseSmtpUrl reads scheme, host, port defaults, and credentials', () => {
    expect(parseSmtpUrl('smtp://mail.example.test')).toEqual({ host: 'mail.example.test', port: 25, secure: false, user: null, pass: null });
    expect(parseSmtpUrl('smtps://u%40x:p%3Aw@mail.example.test')).toEqual({ host: 'mail.example.test', port: 465, secure: true, user: 'u@x', pass: 'p:w' });
    expect(parseSmtpUrl('smtp://u:p@h:2525').port).toBe(2525);
    expect(() => parseSmtpUrl('http://x')).toThrow();
  });

  it('buildMessage folds header injection and dot-stuffs the body', () => {
    const msg = buildMessage({ from: 'od-hub@x', to: 'a@b\r\nBcc: evil@x', subject: 'Hi\nthere', text: 'line1\n.hidden\nline3' }, new Date('2026-09-08T00:00:00Z'));
    expect(msg).toContain('To: a@b Bcc: evil@x\r\n');
    expect(msg).toContain('Subject: Hi there\r\n');
    expect(msg.split('\r\n\r\n')[1]).toBe('line1\r\n..hidden\r\nline3');
    expect(encodeBody('.\n..')).toBe('..\r\n...');
  });

  it('addressOf extracts the bare address', () => {
    expect(addressOf('Alice <alice@example.test>')).toBe('alice@example.test');
    expect(addressOf(' bob@example.test ')).toBe('bob@example.test');
    expect(addressOf('x<a@b>\r\ny')).toBe('a@b');
  });
});

describe('createSmtpMailer', () => {
  const fake = new FakeSmtp();
  afterEach(() => fake.stop());

  it('runs EHLO -> AUTH PLAIN -> MAIL -> RCPT -> DATA -> QUIT and delivers the encoded message', async () => {
    const hostPort = await fake.start();
    fake.requireAuth = true;
    const mailer = createSmtpMailer(`smtp://hub:secret@${hostPort}`, { name: 'od-hub.test' });
    await mailer.send({ from: 'OD Hub <od-hub@example.test>', to: 'carol@example.test', subject: 'Invite', text: 'Open https://hub/console/invites/abc\n.done' });
    expect(fake.authenticated).toBe('hub');
    expect(fake.commands.map((c) => c.split(' ')[0])).toEqual(['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']);
    expect(fake.commands).toContain('MAIL FROM:<od-hub@example.test>');
    expect(fake.commands).toContain('RCPT TO:<carol@example.test>');
    expect(fake.data).toContain('Subject: Invite\r\n');
    expect(fake.data).toContain('\r\n\r\nOpen https://hub/console/invites/abc\r\n..done');
  });

  it('a rejected AUTH surfaces as an error the invite service can log', async () => {
    const hostPort = await fake.start();
    const mailer = createSmtpMailer(`smtp://hub:wrong@${hostPort}`);
    await expect(mailer.send({ from: 'a@b', to: 'c@d', subject: 's', text: 't' })).rejects.toThrow(/smtp AUTH failed: 535/);
  });
});
