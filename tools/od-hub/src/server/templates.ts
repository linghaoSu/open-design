import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal HTML template renderer for the browser-facing console pages
 * (invite landing, invite accepted, device authorized, error). Templates live
 * under `<tool root>/templates/*.html` and are designed separately; this
 * module only guarantees two things about them:
 *
 *   - `{{name}}` substitutes the variable HTML-escaped. There is no raw output
 *     form on purpose: every value that reaches a page (user names, workspace
 *     names, GitLab hosts) is attacker-influenced somewhere upstream.
 *   - `{{#if name}}...{{else}}...{{/if}}` keeps the first block when the
 *     variable is truthy (non-empty string, `true`, non-zero number) and the
 *     optional `{{else}}` block otherwise. Blocks nest; an `{{else}}` binds to
 *     the innermost open `{{#if}}`.
 *
 *   - `<!-- ... -->` comments are removed before anything else. The designed
 *     files carry designer notes (variable lists, state conventions) in their
 *     header; those must neither be evaluated as placeholders nor reach the
 *     browser.
 *
 * Unknown variables render as the empty string so a designed template can
 * reference a field the server has not learned about yet without breaking.
 */

export type TemplateVars = Record<string, string | number | boolean | null | undefined>;

/**
 * `=` is escaped alongside the usual five plus the backtick so an injected
 * value can never form a new `name=value` pair inside an unquoted attribute.
 */
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
  '=': '&#61;',
};

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`=]/g, (ch) => ESCAPES[ch] ?? ch);
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  return true;
}

const IF_OPEN = /\{\{#if\s+([A-Za-z_][\w.-]*)\s*\}\}/g;

/**
 * Resolve `{{#if}}` blocks innermost-first so nesting works without a real
 * parser: repeatedly rewrite the first block whose body contains no other
 * `{{#if` until none are left. Unbalanced blocks throw at render time.
 */
function resolveConditionals(source: string, vars: TemplateVars): string {
  let out = source;
  for (let guard = 0; guard < 10_000; guard += 1) {
    IF_OPEN.lastIndex = 0;
    const open = IF_OPEN.exec(out);
    if (!open) return out;
    // Find the innermost: the LAST `{{#if` before the first `{{/if}}`.
    const firstClose = out.indexOf('{{/if}}');
    if (firstClose === -1) throw new Error(`template: unclosed {{#if ${open[1]}}}`);
    let innermost = open;
    for (;;) {
      IF_OPEN.lastIndex = innermost.index + innermost[0].length;
      const next = IF_OPEN.exec(out);
      if (!next || next.index > firstClose) break;
      innermost = next;
    }
    const body = out.slice(innermost.index + innermost[0].length, firstClose);
    // The innermost body contains no `{{#if`, so any `{{else}}` in it is ours.
    const elseAt = body.indexOf('{{else}}');
    if (elseAt !== -1 && body.indexOf('{{else}}', elseAt + '{{else}}'.length) !== -1) {
      throw new Error(`template: duplicate {{else}} in {{#if ${innermost[1]}}}`);
    }
    const thenBody = elseAt === -1 ? body : body.slice(0, elseAt);
    const elseBody = elseAt === -1 ? '' : body.slice(elseAt + '{{else}}'.length);
    const replacement = truthy(vars[innermost[1]!]) ? thenBody : elseBody;
    out = out.slice(0, innermost.index) + replacement + out.slice(firstClose + '{{/if}}'.length);
  }
  throw new Error('template: too many conditionals');
}

const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** Drop designer comments (and the whitespace-only lines they leave behind). */
export function stripComments(source: string): string {
  return source.replace(HTML_COMMENT, '').replace(/^[ \t]*\r?\n/gm, '');
}

export function renderTemplate(source: string, vars: TemplateVars): string {
  const withBlocks = resolveConditionals(stripComments(source), vars);
  if (withBlocks.includes('{{/if}}')) throw new Error('template: stray {{/if}}');
  if (withBlocks.includes('{{else}}')) throw new Error('template: stray {{else}}');
  return withBlocks.replace(/\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g, (_match, name: string) => escapeHtml(vars[name]));
}

/**
 * Locate `templates/` relative to the running module, exactly like
 * `resolveMigrationsDir`: source runs from `src/server/`, the esbuild bundle
 * from `dist/`; both sit under the tool root.
 */
export function resolveTemplatesDir(fromUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(dir, 'templates');
    if (existsSync(join(candidate, 'error.html'))) return candidate;
    dir = resolve(dir, '..');
  }
  throw new Error('templates directory not found');
}

export type TemplateName = 'device-authorized' | 'invite-landing' | 'invite-accepted' | 'error';

/** File-backed template set; sources are cached after the first read. */
export class Templates {
  private readonly cache = new Map<string, string>();

  constructor(private readonly dir: string = resolveTemplatesDir()) {}

  source(name: TemplateName): string {
    let src = this.cache.get(name);
    if (src === undefined) {
      src = readFileSync(join(this.dir, `${name}.html`), 'utf8');
      this.cache.set(name, src);
    }
    return src;
  }

  render(name: TemplateName, vars: TemplateVars): string {
    return renderTemplate(this.source(name), vars);
  }
}
