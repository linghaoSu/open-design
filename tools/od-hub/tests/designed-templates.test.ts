import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveTemplatesDir, Templates, type TemplateName, type TemplateVars } from '../src/server/templates.js';

/**
 * The four console pages under `templates/` are designed outside this repo
 * and dropped in as files. This suite renders the REAL files through the
 * renderer with representative server variables and pins the properties the
 * HTTP layer relies on: every placeholder is consumed, values are escaped in
 * place, the landing page collapses to exactly one state, and the pages stay
 * self-contained (no script, no external resource) so the strict CSP in
 * http.ts `html()` never blocks anything the design needs.
 */
const XSS = '<script>alert(1)</script>';
const XSS_ESCAPED = '&lt;script&gt;alert(1)&lt;/script&gt;';

const dir = resolveTemplatesDir();
const templates = new Templates(dir);

const LANDING_BASE: TemplateVars = {
  workspaceName: 'Design Team',
  inviterName: XSS,
  role: 'member',
  invitedEmailMasked: 'c***@example.test',
  expiresAt: '2026-09-15 08:30 UTC',
  acceptUrl: 'https://hub.example.test/console/invites/tok/accept',
  downloadUrl: 'https://dl.example.test/od',
};

const CASES: Array<{ name: TemplateName; vars: TemplateVars; expectVisible: string[] }> = [
  {
    name: 'device-authorized',
    vars: { userName: XSS, userEmail: 'alice@example.test', gitlabHost: 'gitlab.example.test', deeplinkUrl: 'opendesign://workspace/x?a=1' },
    expectVisible: [XSS_ESCAPED, 'alice@example.test', 'gitlab.example.test', 'opendesign://workspace/x?a&#61;1'],
  },
  {
    name: 'invite-accepted',
    vars: { workspaceName: XSS, role: 'admin', deeplinkUrl: 'opendesign://workspace/invite/continue?nonce=n', fallbackDownloadUrl: 'https://dl.example.test/od', expiresInMinutes: 10 },
    expectVisible: [XSS_ESCAPED, '>admin<', 'opendesign://workspace/invite/continue?nonce&#61;n', 'https://dl.example.test/od', '>10<'],
  },
  {
    name: 'error',
    vars: { title: XSS, message: 'This invitation has expired.', code: 'invite_expired', backUrl: 'https://hub.example.test/' },
    expectVisible: [XSS_ESCAPED, 'This invitation has expired.', 'invite_expired', 'https://hub.example.test/'],
  },
  {
    name: 'invite-landing',
    vars: { ...LANDING_BASE, statePending: true },
    expectVisible: [XSS_ESCAPED, 'Design Team', 'c***@example.test', '2026-09-15 08:30 UTC', 'https://hub.example.test/console/invites/tok/accept', 'https://dl.example.test/od'],
  },
];

function bodyClass(out: string): string {
  const match = /<body class="([^"]*)">/.exec(out);
  if (!match) throw new Error('no <body class> in output');
  return match[1]!;
}

describe('designed console templates render through the renderer', () => {
  for (const { name, vars, expectVisible } of CASES) {
    it(`${name}: every placeholder is consumed and values appear escaped`, () => {
      const out = templates.render(name, vars);
      expect(out, 'unreplaced placeholder').not.toContain('{{');
      expect(out).not.toContain('}}');
      expect(out).not.toContain(XSS);
      for (const needle of expectVisible) expect(out, needle).toContain(needle);
      expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
      expect(out).toContain('</html>');
      // Designer header notes are source-only.
      expect(out).not.toContain('<!--');
      expect(out).not.toContain('模板变量');
    });
  }

  it('templates are self-contained: no script, no external http(s) resource references', () => {
    for (const name of ['device-authorized', 'invite-accepted', 'error', 'invite-landing'] as TemplateName[]) {
      const src = readFileSync(path.join(dir, `${name}.html`), 'utf8');
      expect(src.toLowerCase(), `${name} <script`).not.toContain('<script');
      expect(src, `${name} inline handler`).not.toMatch(/\son[a-z]+\s*=/i);
      expect(src, `${name} javascript: url`).not.toMatch(/(href|src)\s*=\s*["']?\s*javascript:/i);
      // Resource fetches: <link href>, src=, @import, url(...) — a bare <a href="{{var}}"> is fine.
      expect(src, `${name} <link`).not.toMatch(/<link\b/i);
      expect(src, `${name} src=`).not.toMatch(/\ssrc\s*=\s*["']?https?:/i);
      expect(src, `${name} @import`).not.toMatch(/@import/i);
      expect(src, `${name} url(http`).not.toMatch(/url\(\s*["']?https?:/i);
      expect(src, `${name} literal http(s) url`).not.toMatch(/https?:\/\//i);
    }
  });

  describe('invite-landing states', () => {
    const states = [
      { flag: 'statePending', cls: 'pending', section: 'invite-pending' },
      { flag: 'stateExpired', cls: 'expired', section: 'invite-expired' },
      { flag: 'stateAlreadyAccepted', cls: 'already-accepted', section: 'invite-already-accepted' },
    ] as const;

    for (const { flag, cls, section } of states) {
      it(`${flag} -> body class "${cls}" with only that section rendered`, () => {
        const out = templates.render('invite-landing', { ...LANDING_BASE, [flag]: true });
        expect(bodyClass(out)).toBe(cls);
        expect(out).toContain(`id="${section}"`);
        for (const other of states) {
          if (other.section !== section) expect(out, other.section).not.toContain(`id="${other.section}"`);
        }
        // The accept link is a pending-only affordance.
        if (cls === 'pending') expect(out).toContain(String(LANDING_BASE.acceptUrl));
        else expect(out).not.toContain(String(LANDING_BASE.acceptUrl));
        expect(out).not.toContain('{{');
      });
    }

    it('no state flag renders an empty body class and no state section (server always sets exactly one)', () => {
      const out = templates.render('invite-landing', LANDING_BASE);
      expect(bodyClass(out)).toBe('');
      for (const { section } of states) expect(out).not.toContain(`id="${section}"`);
    });
  });
});
