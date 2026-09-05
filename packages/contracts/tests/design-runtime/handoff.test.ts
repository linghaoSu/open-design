import { describe, expect, it } from 'vitest';
import {
  CreateHandoffRequestSchema, HandoffBindingCoverageSchema, HandoffBuildResultSchema,
  HandoffCodeResultSchema, HandoffManifestSchema, HandoffTargetPackageSchema,
  type HandoffManifest, type ValidationDiagnostic,
  codeImportPackageName,
} from '../../src/design-runtime/index.js';

const error: ValidationDiagnostic = { schemaVersion: 1, code: 'ODDS7001', severity: 'error', message: 'Action required.' };
function manifest(): HandoffManifest {
  return { schemaVersion: 1, id: 'handoff', projectId: 'project', projectRevision: 0, framework: 'react',
    snapshot: { registry: null, projectComponents: { schemaVersion: 1, id: 'project', components: [] },
      baseCodeIndex: { schemaVersion: 1, id: 'base', components: [] }, projectCodeIndex: { schemaVersion: 1, id: 'project', components: [] },
      bindings: { schemaVersion: 1, id: 'project', bindings: [] }, document: { schemaVersion: 1, id: 'document', screens: [] },
      dependencies: { schemaVersion: 1, id: 'project', dependencies: [] }, lock: { schemaVersion: 1, id: 'project', dependencies: [] },
      versions: [], projectSources: [], targetPackages: [],
    }, coverage: [], ready: true, diagnostics: [],
  };
}

describe('portable handoff contracts', () => {
  it('derives installation identity from scoped/unscoped imports without admitting path or URL traversal', () => {
    expect(codeImportPackageName('@acme/ui/button')).toBe('@acme/ui');
    expect(codeImportPackageName('ui/components/button.js')).toBe('ui');
    expect(codeImportPackageName('@acme/ui')).toBe('@acme/ui');
    for (const input of ['../private', '/absolute', '@acme/ui/../private', 'ui//button', 'ui/./button', 'https://host/ui', 'node:fs', 'ui\\private', 'ui/%2e%2e/private', 'ui?query', 'ui#fragment']) expect(codeImportPackageName(input)).toBeNull();
  });
  it('round-trips the versioned snapshot and rejects crossed project aggregate identities', () => {
    const input = manifest(); expect(HandoffManifestSchema.parse(JSON.parse(JSON.stringify(input)))).toEqual(input);
    const { schemaVersion: _, coverage: _coverage, ready: _ready, diagnostics: _diagnostics, ...request } = input;
    expect(CreateHandoffRequestSchema.parse(request)).toEqual(request);
    expect(CreateHandoffRequestSchema.safeParse({ ...request, projectId: 'other' }).success).toBe(false);
    input.snapshot.projectCodeIndex.id = 'other';
    expect(HandoffManifestSchema.safeParse(input).success).toBe(false);
  });

  it('keeps installed exact observations separate from declared ranges or unknown evidence', () => {
    const declared = { name: '@acme/ui', declaredRange: '^1.0.0', installation: { status: 'unknown' as const } };
    expect(HandoffTargetPackageSchema.parse(declared)).toEqual(declared);
    expect(HandoffTargetPackageSchema.safeParse({ ...declared, installation: { status: 'observed', version: '^1.0.0' } }).success).toBe(false);
    const input = manifest(); input.snapshot.targetPackages = [declared, declared];
    expect(HandoffManifestSchema.safeParse(input).success).toBe(false);
  });

  it('does not certify legacy local bindings or hide incomplete binding and build diagnostics', () => {
    const binding = { schemaVersion: 1, id: 'binding', componentRef: 'local:card', framework: 'react', status: 'bound', verified: true, codeComponentId: 'card' };
    const coverage = { componentRef: 'local:card', binding, ready: true, diagnostics: [] };
    expect(HandoffBindingCoverageSchema.safeParse(coverage).success).toBe(false);
    expect(HandoffBindingCoverageSchema.safeParse({ ...coverage, binding: { ...binding, definitionRevision: 2 } }).success).toBe(true);
    expect(HandoffBindingCoverageSchema.safeParse({ ...coverage, ready: false, binding: null }).success).toBe(false);
    const input = manifest(); input.ready = false; input.coverage = [{ componentRef: 'local:card', binding: null, ready: false, diagnostics: [error] }]; input.diagnostics = [error];
    expect(HandoffManifestSchema.safeParse({ ...input, ready: true }).success).toBe(false);
    expect(HandoffManifestSchema.safeParse({ ...input, coverage: [...input.coverage, ...input.coverage] }).success).toBe(false);
    expect(HandoffBuildResultSchema.safeParse({ schemaVersion: 1, manifest: input, diagnostics: [] }).success).toBe(false);
    expect(HandoffBuildResultSchema.parse({ schemaVersion: 1, manifest: input, diagnostics: [error] }).manifest?.ready).toBe(false);
    expect(HandoffBuildResultSchema.safeParse({ schemaVersion: 1, manifest: null, diagnostics: [] }).success).toBe(false);
  });

  it('keeps code emission atomic and rejects duplicate portable paths', () => {
    const file = { screenId: 'main', sourcePath: 'src/Main.tsx', exportName: 'Main', language: 'tsx', content: 'export function Main(){}' };
    const success = { schemaVersion: 1, ok: true, files: [file], diagnostics: [] };
    expect(HandoffCodeResultSchema.parse(JSON.parse(JSON.stringify(success)))).toEqual(success);
    expect(HandoffCodeResultSchema.safeParse({ ...success, ok: false, diagnostics: [error] }).success).toBe(false);
    expect(HandoffCodeResultSchema.safeParse({ ...success, diagnostics: [error] }).success).toBe(false);
    expect(HandoffCodeResultSchema.safeParse({ ...success, files: [file, { ...file, screenId: 'second', sourcePath: 'src/main.tsx' }] }).success).toBe(false);
    expect(HandoffCodeResultSchema.parse({ schemaVersion: 1, ok: false, files: [], diagnostics: [error] }).ok).toBe(false);
  });
});
