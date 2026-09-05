import {
  CompileSourceComponentRequestSchema, CompileSourceComponentResultSchema, ExtractSourceCodeComponentRequestSchema,
  type CompileSourceComponentRequest, type CompileSourceComponentResult, type ExtractSourceCodeComponentRequest, type CodeComponentDefinition,
} from '@open-design/contracts';
import { compileReactComponent, extractReactCodeComponent } from './react-compiler.js';
import { compileVueComponent, extractVueCodeComponent } from './vue-compiler.js';

/** Shared source-proof boundary; no registry policy or bound relationship is fabricated here. */
export function extractSourceCodeComponent(input: ExtractSourceCodeComponentRequest): CodeComponentDefinition {
  const request = ExtractSourceCodeComponentRequestSchema.parse(input);
  if (request.framework === 'react') return extractReactCodeComponent(request);
  return extractVueCodeComponent(request);
}

/** Design compilation additionally requires every design/code slot mapping to be explicit and valid. */
export function compileSourceComponent(input: CompileSourceComponentRequest): CompileSourceComponentResult {
  const request = CompileSourceComponentRequestSchema.parse(input);
  if (request.framework === 'react') return CompileSourceComponentResultSchema.parse({ schemaVersion: 1, ...compileReactComponent(request) });
  return CompileSourceComponentResultSchema.parse(compileVueComponent(request));
}
