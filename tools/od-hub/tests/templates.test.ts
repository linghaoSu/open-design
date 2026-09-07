import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { escapeHtml, renderTemplate, resolveTemplatesDir, Templates } from '../src/server/templates.js';

describe('renderTemplate', () => {
  it('HTML-escapes every substitution, including an XSS attempt in userName', () => {
    const out = renderTemplate('<p>Hi {{userName}}</p>', { userName: '<script>alert(1)</script>"\'`&' });
    expect(out).toBe('<p>Hi &lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&#96;&amp;</p>');
    expect(out).not.toContain('<script>');
  });

  it('escapes attribute contexts so a crafted URL cannot break out of href', () => {
    const out = renderTemplate('<a href="{{url}}">x</a>', { url: 'javascript:alert(1)" onmouseover="evil()' });
    expect(out).toBe('<a href="javascript:alert(1)&quot; onmouseover&#61;&quot;evil()">x</a>');
  });

  it('escapes `=` so a value in an unquoted attribute cannot start a new attribute', () => {
    expect(renderTemplate('<a data-x={{v}}>x</a>', { v: 'a onclick=alert(1)' })).toBe('<a data-x=a onclick&#61;alert(1)>x</a>');
    expect(escapeHtml('a=b')).toBe('a&#61;b');
  });

  it('{{#if}}...{{else}}...{{/if}} picks exactly one branch, also when nested', () => {
    const src = '{{#if a}}A{{else}}notA{{/if}}|{{#if b}}{{#if c}}BC{{else}}BnotC{{/if}}{{else}}notB{{/if}}';
    expect(renderTemplate(src, { a: true, b: true, c: true })).toBe('A|BC');
    expect(renderTemplate(src, { a: '', b: 1, c: 0 })).toBe('notA|BnotC');
    expect(renderTemplate(src, { a: 'x', b: false, c: true })).toBe('A|notB');
    // Variables inside the untaken branch are never evaluated.
    expect(renderTemplate('{{#if show}}{{secret}}{{else}}fallback{{/if}}', { show: false, secret: 'S' })).toBe('fallback');
    expect(renderTemplate('{{#if show}}shown{{else}}{{secret}}{{/if}}', { show: true, secret: 'S' })).toBe('shown');
  });

  it('rejects a stray or duplicate {{else}}', () => {
    expect(() => renderTemplate('x{{else}}y', {})).toThrow(/stray \{\{else\}\}/);
    expect(() => renderTemplate('{{#if a}}x{{else}}y{{else}}z{{/if}}', { a: true })).toThrow(/duplicate/);
  });

  it('renders unknown variables as empty and tolerates spaces inside the braces', () => {
    expect(renderTemplate('[{{ missing }}][{{name}}]', { name: 'n' })).toBe('[][n]');
  });

  it('{{#if}} keeps the block for truthy values and drops it otherwise, nested', () => {
    const src = 'a{{#if x}}X{{#if y}}Y{{/if}}{{/if}}b{{#if z}}Z{{/if}}';
    expect(renderTemplate(src, { x: true, y: 'yes', z: 0 })).toBe('aXYb');
    expect(renderTemplate(src, { x: 'v', y: '', z: 1 })).toBe('aXbZ');
    expect(renderTemplate(src, { x: null })).toBe('ab');
  });

  it('values inside a dropped block are never evaluated (no leakage)', () => {
    expect(renderTemplate('{{#if show}}{{secret}}{{/if}}', { show: false, secret: 'S' })).toBe('');
  });

  it('rejects unbalanced conditionals', () => {
    expect(() => renderTemplate('{{#if a}}x', { a: true })).toThrow(/unclosed/);
    expect(() => renderTemplate('x{{/if}}', {})).toThrow(/stray/);
  });

  it('strips HTML comments before substitution so designer notes never reach the browser or get evaluated', () => {
    const src = '<!--\nnotes: {{secret}} and {{#if x}}\n-->\n<p>{{name}}</p><!-- inline --><i>x</i>';
    const out = renderTemplate(src, { name: 'n', secret: 'S' });
    expect(out).toBe('<p>n</p><i>x</i>');
    expect(out).not.toContain('S');
  });

  it('escapeHtml handles null/undefined/number', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('placeholder templates', () => {
  const dir = resolveTemplatesDir();
  const templates = new Templates(dir);

  it('ship the four files with the contracted variables', () => {
    const expectVars = (name: string, vars: string[]) => {
      const file = path.join(dir, `${name}.html`);
      expect(existsSync(file)).toBe(true);
      const src = readFileSync(file, 'utf8');
      for (const v of vars) expect(src).toContain(`{{${v}}}`);
    };
    expectVars('device-authorized', ['userName', 'userEmail', 'gitlabHost', 'deeplinkUrl']);
    expectVars('invite-landing', ['workspaceName', 'inviterName', 'role', 'invitedEmailMasked', 'expiresAt', 'acceptUrl', 'downloadUrl']);
    expectVars('invite-accepted', ['workspaceName', 'role', 'deeplinkUrl', 'fallbackDownloadUrl', 'expiresInMinutes']);
    expectVars('error', ['title', 'message', 'code', 'backUrl']);
  });

  it('invite-landing renders each state exclusively', () => {
    const base = { workspaceName: 'W', inviterName: 'I', role: 'member', invitedEmailMasked: 'j***@x.y', expiresAt: 'E', acceptUrl: 'https://h/a', downloadUrl: 'https://h/d' };
    const pending = templates.render('invite-landing', { ...base, statePending: true });
    expect(pending).toContain('https://h/a');
    expect(pending).toContain('id="invite-pending"');
    expect(pending).not.toContain('id="invite-already-accepted"');
    const expired = templates.render('invite-landing', { ...base, stateExpired: true });
    expect(expired).not.toContain('https://h/a');
    expect(expired).toContain('id="invite-expired"');
    const accepted = templates.render('invite-landing', { ...base, stateAlreadyAccepted: true });
    expect(accepted).toContain('id="invite-already-accepted"');
    expect(accepted).not.toContain('https://h/a');
  });

  it('device-authorized escapes a hostile user name', () => {
    const out = templates.render('device-authorized', { userName: '<img src=x onerror=alert(1)>', userEmail: 'a@b', gitlabHost: 'g', deeplinkUrl: '' });
    expect(out).toContain('&lt;img src&#61;x onerror&#61;alert(1)&gt;');
    expect(out).not.toContain('<img');
  });
});
