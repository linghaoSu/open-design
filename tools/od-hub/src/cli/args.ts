export interface ParsedArgs {
  /** Positional tokens in order (everything that is not a flag or a flag value). */
  positionals: string[];
  /** `--key value` pairs; repeated keys collect into arrays. Bare `--flag` maps to `true`. */
  flags: Record<string, string | string[] | true>;
}

/**
 * Minimal Cobra-like argv parser. Flags declared in `valueFlags` always take
 * the next token as their value; every other `--x` is boolean unless written
 * `--x=value`. Repeated value flags (e.g. `--exclude`) accumulate.
 */
export function parseArgs(argv: string[], valueFlags: ReadonlySet<string>): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | string[] | true> = {};
  const push = (key: string, value: string | true) => {
    const existing = flags[key];
    if (existing === undefined || value === true) {
      flags[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else if (existing === true) {
      flags[key] = value;
    } else {
      flags[key] = [existing, value];
    }
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq !== -1) {
      push(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const key = token.slice(2);
    if (valueFlags.has(key) && index + 1 < argv.length) {
      push(key, argv[index + 1]!);
      index += 1;
    } else {
      push(key, true);
    }
  }
  return { positionals, flags };
}

export function flagString(flags: ParsedArgs['flags'], key: string): string | null {
  const value = flags[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[value.length - 1] ?? null;
  return null;
}
