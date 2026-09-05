import type * as t from '@babel/types';
import { ComponentSlotDefinitionSchema, ComponentSlotMappingSchema, type ComponentSlotDefinition, type ComponentSlotMapping } from '@open-design/contracts';
import { assertStaticMetadataUses, metadataFields, metadataLiteral, metadataObject, selectedMetadataExport, type MetadataFailure } from './static-source-metadata.js';

/** Explicit semantic slot policy is owner evidence, separate from source-proven code capability. */
export function readExplicitSlotMetadata(program: t.Program, input: { sourcePath: string; exportName: string; metadataExportName?: string | undefined }, fail: MetadataFailure):
  { slots: Record<string, ComponentSlotDefinition>; mappings: ComponentSlotMapping[] } | undefined {
  if (!input.metadataExportName) return undefined;
  assertStaticMetadataUses(program, new Set([input.metadataExportName]), fail);
  const root = selectedMetadataExport(program, input.metadataExportName, fail);
  const metadata = metadataObject(root, fail);
  metadataFields(metadata, ['component', 'slots'], fail);
  const component = metadata.get('component')?.value;
  if (component?.type !== 'Identifier' || component.name !== input.exportName) fail('Slot metadata must identify the selected component export directly', component ?? root);
  const slotRoot = metadata.get('slots')?.value;
  if (!slotRoot) fail('Slot metadata requires an explicit slots object', root);
  const slots: Record<string, ComponentSlotDefinition> = Object.create(null);
  const mappings: ComponentSlotMapping[] = [];
  for (const [name, property] of [...metadataObject(slotRoot, fail)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const fields = metadataObject(property.value, fail);
    metadataFields(fields, ['codeSlot', 'accepts', 'required', 'multiple'], fail);
    const literal = Object.fromEntries([...fields].map(([key, entry]) => [key, metadataLiteral(entry.value, fail)]));
    const source = { kind: 'manual' as const, sourcePath: input.sourcePath, exportName: input.metadataExportName,
      ...(property.loc ? { line: property.loc.start.line } : {}), confidence: 1 };
    const slot = ComponentSlotDefinitionSchema.safeParse({ accepts: literal.accepts, required: literal.required, multiple: literal.multiple, source });
    const mapping = ComponentSlotMappingSchema.safeParse({ designSlot: name, codeSlot: literal.codeSlot, source });
    if (!slot.success || !mapping.success) fail(`Invalid explicit slot metadata: ${(!slot.success ? slot.error : !mapping.success ? mapping.error : undefined)?.message}`, property);
    slots[name] = slot.data; mappings.push(mapping.data);
  }
  return { slots, mappings };
}
