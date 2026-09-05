import { z } from 'zod';
import { ComponentPropsSchema, ComponentSlotDefinitionSchema } from './component-registry.js';
import { DesignEntityIdSchema, DesignMemberNameSchema, DesignRuntimeSchemaVersionSchema } from './common.js';
import { ProjectComponentPropMappingSchema, validateTemplatePropMappings } from './project-components.js';
import { UIIRNodeSchema, type UIIRNode } from './ui-ir.js';

export const DesignPatternSlotMappingSchema = z.object({
  slot: DesignMemberNameSchema, nodeId: DesignEntityIdSchema, targetSlot: DesignMemberNameSchema,
}).strict();
export type DesignPatternSlotMapping = z.infer<typeof DesignPatternSlotMappingSchema>;

/** Reusable DS-only structure with explicit public prop and slot configuration points. */
export const DesignPatternDefinitionSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: DesignEntityIdSchema,
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  props: ComponentPropsSchema,
  template: UIIRNodeSchema,
  propMappings: z.array(ProjectComponentPropMappingSchema),
  slots: z.record(DesignMemberNameSchema, ComponentSlotDefinitionSchema),
  slotMappings: z.array(DesignPatternSlotMappingSchema),
}).strict().superRefine((pattern, ctx) => {
  validateTemplatePropMappings(pattern, ctx);
  const nodes = new Map<string, UIIRNode>();
  const visit = (node: UIIRNode, path: (string | number)[]): void => {
    nodes.set(node.id, node);
    if (node.type !== 'text' && !node.ref.startsWith('ds:')) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'ref'], message: 'Packaged patterns cannot reference project-local components.' });
    if (node.type === 'component') for (const [slot, children] of Object.entries(node.slots ?? {})) children.forEach((child, index) => visit(child, [...path, 'slots', slot, index]));
  };
  visit(pattern.template, ['template']);
  const mapped = new Set<string>();
  const targets = new Set<string>();
  pattern.slotMappings.forEach((mapping, index) => {
    const path = ['slotMappings', index];
    if (!Object.hasOwn(pattern.slots, mapping.slot)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'slot'], message: 'Mapped public slot is not declared.' });
    const key = JSON.stringify([mapping.nodeId, mapping.targetSlot]);
    if (mapped.has(mapping.slot) || targets.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Pattern slot mappings must be one-to-one.' });
    mapped.add(mapping.slot);
    targets.add(key);
    const node = nodes.get(mapping.nodeId);
    if (node?.type !== 'component') ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'nodeId'], message: 'Slot mapping requires a component template node.' });
    else if (Object.hasOwn(node.slots ?? {}, mapping.targetSlot) && node.slots![mapping.targetSlot]!.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Mapped template slots must be absent or empty configuration points.' });
  });
  for (const name of Object.keys(pattern.slots)) if (!mapped.has(name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slots', name], message: 'Every public pattern slot needs an explicit template mapping.' });
});
export type DesignPatternDefinition = z.infer<typeof DesignPatternDefinitionSchema>;

export const DesignPatternRegistrySchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema, id: DesignEntityIdSchema, patterns: z.array(DesignPatternDefinitionSchema),
}).strict().superRefine((registry, ctx) => {
  const ids = new Set<string>();
  registry.patterns.forEach((pattern, index) => {
    if (ids.has(pattern.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['patterns', index, 'id'], message: 'Pattern IDs must be unique.' });
    ids.add(pattern.id);
  });
});
export type DesignPatternRegistry = z.infer<typeof DesignPatternRegistrySchema>;
