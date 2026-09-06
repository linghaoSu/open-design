import {
  ComponentPreviewRequestSchema, ComponentPreviewResponseSchema,
  type ComponentPreviewRequest, type ComponentPreviewResponse, type DesignPreviewSourceEvidence, type DesignSystemSourceFile,
} from '@open-design/contracts';
import { bundleComponentPreview, previewRuntimePackages } from './preview-bundler.js';
import { analyzeComponentPreviewSource } from './preview-props.js';
import { DesignPreviewError, previewDigest } from './preview-preparation.js';
import { decodeDesignRuntimeSource } from './source-text.js';

export interface ComponentPreviewAuthority {
  readSourceFile(path: string): Promise<DesignSystemSourceFile>;
  projectRoot?: string | undefined;
  assertCurrent(): Promise<void>;
  assertCurrentSync(): void;
}

/** File previews are read-only and independent of the project's structured registry, lock or validation mode. */
export function createComponentPreviewService(deps: { acquireAuthority(projectId: string): Promise<ComponentPreviewAuthority> }) {
  return { async componentPreview(projectId: string, raw: ComponentPreviewRequest, reauthorize: () => Promise<void> = async () => {}): Promise<ComponentPreviewResponse> {
    const request = ComponentPreviewRequestSchema.parse(raw);
    const authority = await deps.acquireAuthority(projectId); await authority.assertCurrent();
    const sources = new Map<string, Promise<Uint8Array>>(); let totalBytes = 0;
    const readCurrent = async (path: string): Promise<Uint8Array> => {
      const file = await authority.readSourceFile(path);
      if (file.path !== path) throw new DesignPreviewError('INVALID_REQUEST', 'The preview reader returned a different project path.');
      return Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
    };
    const readFile = (path: string): Promise<Uint8Array> => {
      let pending = sources.get(path);
      if (!pending) {
        if (sources.size >= 256) return Promise.reject(new DesignPreviewError('INVALID_REQUEST', 'Component preview exceeded its source file budget.'));
        pending = readCurrent(path).then((value) => {
          totalBytes += value.length;
          if (value.length > 4 * 1024 * 1024 || totalBytes > 24 * 1024 * 1024) throw new DesignPreviewError('INVALID_REQUEST', 'Component preview exceeded its source byte budget.');
          return value;
        }); sources.set(path, pending);
      }
      return pending;
    };
    let source: Uint8Array;
    try { source = await readFile(request.sourcePath); }
    catch (error) { if (error instanceof DesignPreviewError) throw error; throw new DesignPreviewError('INVALID_REQUEST', 'Selected component source could not be read.'); }
    const sourceText = decodeDesignRuntimeSource(Buffer.from(source));
    const analyzed = analyzeComponentPreviewSource({ ...request, sourceText });
    let bundle: ComponentPreviewResponse['bundle'] = null;
    let evidence: DesignPreviewSourceEvidence[] = [{ origin: 'current-project', sourcePath: request.sourcePath, byteLength: source.length, digest: previewDigest(Buffer.from(source).toString('base64')) }];
    const diagnostics = [...analyzed.diagnostics];
    let verifyInstalledSources = async () => true;
    if (analyzed.selectedExport !== null && !diagnostics.some((entry) => entry.severity === 'error')) {
      const built = await bundleComponentPreview({ sourcePath: request.sourcePath, sourceText, exportName: analyzed.selectedExport, props: analyzed.effectiveProps, callbacks: analyzed.callbacks }, {
        readProjectSource: async (path) => decodeDesignRuntimeSource(Buffer.from(await readFile(path))), readProjectFile: readFile, projectRoot: authority.projectRoot,
      });
      bundle = built.bundle; diagnostics.push(...built.diagnostics); evidence = built.sourceEvidence; verifyInstalledSources = built.verifyInstalledSources;
    }
    // Negative lookups participate too: a newly created higher-priority import changes the source graph.
    for (const [path, pending] of sources) {
      const before = await pending.catch(() => null); const after = await readCurrent(path).catch(() => null);
      if ((before === null) !== (after === null) || before && after && !Buffer.from(before).equals(Buffer.from(after))) throw new DesignPreviewError('CONFLICT', 'Project source changed while the component preview was being built.');
    }
    if (!await verifyInstalledSources()) throw new DesignPreviewError('CONFLICT', 'Installed package source changed while the component preview was being built.');
    await authority.assertCurrent();
    await reauthorize();
    authority.assertCurrentSync();
    return ComponentPreviewResponseSchema.parse({ schemaVersion: 1, projectId, sourcePath: request.sourcePath,
      ...(request.exportName === undefined ? {} : { requestedExport: request.exportName }), requestedProps: request.props ?? {},
      sourceDigest: previewDigest(evidence), ...analyzed, bundle, evidence, diagnostics, runtimePackages: previewRuntimePackages('react'),
    });
  } };
}
