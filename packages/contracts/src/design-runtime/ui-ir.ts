import { z } from 'zod';
import {
  ComponentReferenceSchema,
  DesignEntityIdSchema,
  DesignMemberNameSchema,
  DesignRuntimeSchemaVersionSchema,
  JsonValueSchema,
  type JsonValue,
} from './common.js';

/** V1 overrides a whole prop value. Nested paths, slot overrides and inheritance are future runtime work. */
export const ComponentOverrideSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  path: z.tuple([z.literal('props'), DesignMemberNameSchema]),
  value: JsonValueSchema,
}).strict();
export type ComponentOverride = z.infer<typeof ComponentOverrideSchema>;

/** An instance persists only its reference and explicit overrides, never inherited props/children. */
export const ComponentInstanceSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  type: z.literal('instance'),
  id: DesignEntityIdSchema,
  ref: ComponentReferenceSchema,
  overrides: z.array(ComponentOverrideSchema),
}).strict().superRefine((instance, ctx) => {
  const names = new Set<string>();
  instance.overrides.forEach((override, index) => {
    const name = override.path[1];
    if (names.has(name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['overrides', index, 'path'], message: 'Duplicate prop override.' });
    }
    names.add(name);
  });
});
export type ComponentInstance = z.infer<typeof ComponentInstanceSchema>;

// The recursive node shape is explicit so its exported type does not depend on
// platform APIs. The parser below checks the same shape at the wire boundary.
export type UIIRNode = ComponentInstance | {
  schemaVersion: 1;
  type: 'text';
  id: string;
  text: string;
} | {
  schemaVersion: 1;
  type: 'component';
  id: string;
  ref: string;
  props?: Record<string, JsonValue> | undefined;
  slots?: Record<string, UIIRNode[]> | undefined;
};

export const UIIRNodeSchema: z.ZodType<UIIRNode> = z.lazy(() => z.union([
  ComponentInstanceSchema,
  z.object({
    schemaVersion: DesignRuntimeSchemaVersionSchema,
    type: z.literal('text'),
    id: DesignEntityIdSchema,
    text: z.string(),
  }).strict(),
  z.object({
    schemaVersion: DesignRuntimeSchemaVersionSchema,
    type: z.literal('component'),
    id: DesignEntityIdSchema,
    ref: ComponentReferenceSchema,
    props: z.record(DesignMemberNameSchema, JsonValueSchema).optional(),
    slots: z.record(DesignMemberNameSchema, z.array(UIIRNodeSchema)).optional(),
  }).strict(),
]));

export const UIIRScreenSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  type: z.literal('screen'),
  id: DesignEntityIdSchema,
  name: z.string().min(1).optional(),
  children: z.array(UIIRNodeSchema),
}).strict();
export type UIIRScreen = z.infer<typeof UIIRScreenSchema>;

export const UIIRDocumentSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: DesignEntityIdSchema,
  screens: z.array(UIIRScreenSchema),
}).strict().superRefine((document, ctx) => {
  const ids = new Set<string>();
  const visit = (node: UIIRNode | UIIRScreen, path: (string | number)[]): void => {
    if (ids.has(node.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'id'], message: 'Node IDs must be unique across the document.' });
    }
    ids.add(node.id);
    if (node.type === 'screen') {
      node.children.forEach((child, index) => visit(child, [...path, 'children', index]));
    } else if (node.type === 'component') {
      Object.entries(node.slots ?? {}).forEach(([slot, children]) => {
        children.forEach((child, index) => visit(child, [...path, 'slots', slot, index]));
      });
    }
  };
  document.screens.forEach((screen, index) => visit(screen, ['screens', index]));
});
export type UIIRDocument = z.infer<typeof UIIRDocumentSchema>;
