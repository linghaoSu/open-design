import {
  CompileSourceComponentRequestSchema, CompileSourceComponentResultSchema, ExtractSourceCodeComponentRequestSchema,
  type CompileSourceComponentRequest, type CompileSourceComponentResult, type ExtractSourceCodeComponentRequest, type CodeComponentDefinition,
} from '@open-design/contracts';
import { compileReactComponent, extractReactCodeComponent } from './react-compiler.js';
import { compileVueComponent, extractVueCodeComponent } from './vue-compiler.js';
import type { TypeScriptSourceFiles } from './typescript-source-graph.js';

/** Shared source-proof boundary; no registry policy or bound relationship is fabricated here. */
export function extractSourceCodeComponent(input: ExtractSourceCodeComponentRequest, sourceFiles?: TypeScriptSourceFiles): CodeComponentDefinition {
  const request = ExtractSourceCodeComponentRequestSchema.parse(input);
  if (request.framework === 'react') return extractReactCodeComponent({ ...request, ...(sourceFiles ? { sourceFiles } : {}) });
  return extractVueCodeComponent(request);
}

/** Design compilation additionally requires every design/code slot mapping to be explicit and valid. */
export function compileSourceComponent(input: CompileSourceComponentRequest, sourceFiles?: TypeScriptSourceFiles): CompileSourceComponentResult {
  const request = CompileSourceComponentRequestSchema.parse(input);
  if (request.framework === 'react') return CompileSourceComponentResultSchema.parse({ schemaVersion: 1, ...compileReactComponent({ ...request, ...(sourceFiles ? { sourceFiles } : {}) }) });
  return CompileSourceComponentResultSchema.parse(compileVueComponent(request));
}
