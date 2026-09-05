import { z } from 'zod';
import { ComponentReferenceSchema, DesignEntityIdSchema, DesignMemberNameSchema, JsonScalarSchema } from './common.js';

const dsRef = ComponentReferenceSchema.refine((ref) => ref.startsWith('ds:'), 'Migration rules address design-system components.');
const rule = { id: DesignEntityIdSchema };
export const DesignSystemMigrationRuleSchema = z.discriminatedUnion('type', [
  z.object({ ...rule, type: z.literal('transform-prop'), componentRef: dsRef, fromProp: DesignMemberNameSchema, toProp: DesignMemberNameSchema, valueMap: z.array(z.object({ from: JsonScalarSchema, to: JsonScalarSchema }).strict()).min(1).optional() }).strict(),
  z.object({ ...rule, type: z.literal('drop-prop'), componentRef: dsRef, prop: DesignMemberNameSchema }).strict(),
  z.object({ ...rule, type: z.literal('replace-component'), fromRef: dsRef, toRef: dsRef }).strict(),
  z.object({ ...rule, type: z.literal('rename-slot'), componentRef: dsRef, fromSlot: DesignMemberNameSchema, toSlot: DesignMemberNameSchema }).strict(),
  z.object({ ...rule, type: z.literal('drop-slot'), componentRef: dsRef, slot: DesignMemberNameSchema, children: z.literal('delete') }).strict(),
]);
export type DesignSystemMigrationRule = z.infer<typeof DesignSystemMigrationRuleSchema>;

/** Shared simultaneous-rule invariants for authored plans and immutable package recipes. */
export function refineDesignSystemMigrationRules(rules: readonly DesignSystemMigrationRule[], ctx: z.RefinementCtx, designSystemId?: string): void {
  const ids = new Set<string>(); const sources = new Set<string>(); const targets = new Set<string>();
  rules.forEach((entry, index) => {
    const ref = entry.type === 'replace-component' ? entry.fromRef : entry.componentRef;
    const kind = entry.type.includes('prop') ? 'prop' : entry.type.includes('slot') ? 'slot' : 'component';
    const source = entry.type === 'transform-prop' ? entry.fromProp : entry.type === 'drop-prop' ? entry.prop : entry.type === 'rename-slot' ? entry.fromSlot : entry.type === 'drop-slot' ? entry.slot : '';
    const target = entry.type === 'transform-prop' ? entry.toProp : entry.type === 'rename-slot' ? entry.toSlot : undefined;
    const key = JSON.stringify([ref, kind, source]);
    if (ids.has(entry.id) || sources.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rules', index], message: 'Rule identities and old targets must be unique.' });
    ids.add(entry.id); sources.add(key);
    if (designSystemId !== undefined && (!ref.startsWith(`ds:${designSystemId}/`) || (entry.type === 'replace-component' && !entry.toRef.startsWith(`ds:${designSystemId}/`)))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rules', index], message: 'Rule references must belong to the selected design system.' });
    if (target !== undefined) {
      const key = JSON.stringify([ref, kind, target]);
      if (targets.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rules', index], message: 'Simultaneous rules cannot converge on one member target.' });
      targets.add(key);
    }
    if (entry.type === 'transform-prop' && entry.valueMap) {
      const values = entry.valueMap.map(({ from }) => JSON.stringify(from));
      if (new Set(values).size !== values.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rules', index, 'valueMap'], message: 'Each typed source value has one replacement.' });
    }
  });
}
