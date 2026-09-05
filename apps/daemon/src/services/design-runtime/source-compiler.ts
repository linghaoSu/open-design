import {
  CompileSourceComponentRequestSchema, CompileSourceComponentResultSchema, ExtractSourceCodeComponentRequestSchema,
  type CompileSourceComponentRequest, type CompileSourceComponentResult, type ExtractSourceCodeComponentRequest, type CodeComponentDefinition,
} from '@open-design/contracts';
import { compileReactComponent, extractReactCodeComponent, CompilerError } from './react-compiler.js';

/** Shared source-proof boundary; no registry policy or bound relationship is fabricated here. */
export function extractSourceCodeComponent(input: ExtractSourceCodeComponentRequest): CodeComponentDefinition {
  const request = ExtractSourceCodeComponentRequestSchema.parse(input);
  if (request.framework === 'react') return extractReactCodeComponent(request);
  throw new CompilerError('Vue source extraction is not supported yet', request.sourcePath, request.exportName);
}

/** Design compilation additionally requires every design/code slot mapping to be explicit and valid. */
export function compileSourceComponent(input: CompileSourceComponentRequest): CompileSourceComponentResult {
  const request = CompileSourceComponentRequestSchema.parse(input);
  if (request.framework === 'react') return CompileSourceComponentResultSchema.parse({ schemaVersion: 1, ...compileReactComponent(request) });
  throw new CompilerError('Vue source extraction is not supported yet', request.sourcePath, request.exportName);
}
