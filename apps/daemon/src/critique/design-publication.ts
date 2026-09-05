import type { DesignValidationSource, ValidationDiagnostic } from '@open-design/contracts';
import { generationDigest, generationInventoryDiagnostic } from '../services/design-runtime/generation-inventory.js';

export interface CritiqueDesignPublicationInput {
  production: true;
  externalSources: DesignValidationSource[];
  externalDiagnostics: ValidationDiagnostic[];
}

/** Host-owned candidates use virtual identities; no project file can supply these bytes. */
export function critiqueDesignPublicationInput(artifact: Readonly<{ body: string; mime: string }> | null): CritiqueDesignPublicationInput {
  if (artifact === null) return { production: true, externalSources: [], externalDiagnostics: [generationInventoryDiagnostic(
    'Critique did not produce a verifiable artifact candidate; delivery bytes are unavailable.', '__od_critique__/artifact.unavailable',
  )] };
  const mime = artifact.mime.split(';', 1)[0]?.trim().toLowerCase();
  const language = mime === 'text/html' ? 'html' : mime === 'text/css' ? 'css' : null;
  if (language) return { production: true, externalSources: [{ sourcePath: `__od_critique__/artifact.${language}`,
    language, sourceText: artifact.body }], externalDiagnostics: [] };
  const sourcePath = '__od_critique__/artifact.unsupported';
  return { production: true, externalSources: [], externalDiagnostics: [generationInventoryDiagnostic(
    `Critique artifact MIME ${JSON.stringify(artifact.mime)} is outside deterministic validation coverage; virtual candidate ${sourcePath}, content ${generationDigest(artifact.body)}.`, sourcePath,
  )] };
}
