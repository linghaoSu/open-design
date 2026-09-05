import { z } from 'zod';

const numeric = '(?:0|[1-9][0-9]*)';
const prerelease = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const version = `${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?`;
export const DesignSystemSemVerSchema = z.string().regex(new RegExp(`^${version}$`), 'Expected exact SemVer, without a tag or range.');
export type DesignSystemSemVer = z.infer<typeof DesignSystemSemVerSchema>;
/** Deliberate v1 range subset: exact, caret or tilde of a complete SemVer. Never a latest selector. */
export const DesignSystemVersionRangeSchema = z.string().regex(new RegExp(`^[~^]?${version}$`), 'Expected exact, caret or tilde full-version intent.');
export type DesignSystemVersionRange = z.infer<typeof DesignSystemVersionRangeSchema>;
export const DesignSystemDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type DesignSystemDigest = z.infer<typeof DesignSystemDigestSchema>;
