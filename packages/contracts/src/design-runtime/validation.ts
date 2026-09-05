import { z } from 'zod';
import {
  DesignEntityIdSchema,
  DesignRuntimeSchemaVersionSchema,
  JsonScalarSchema,
  JsonObjectKeySchema,
  JsonValueSchema,
} from './common.js';

/** Stable codes; descriptions/messages may evolve without changing their meaning. */
export const DesignDiagnosticCodeSchema = z.enum([
  'ODDS1001', // UnknownComponent
  'ODDS1002', // UnknownProp
  'ODDS1003', // InvalidVariant (value outside a declared enum)
  'ODDS1004', // InvalidSlotComposition
  'ODDS1005', // InvalidPropType
  'ODDS1006', // MissingRequiredProp
  'ODDS2001', // UnknownToken
  'ODDS2002', // ForbiddenRawColor
  'ODDS2003', // ForbiddenRawSpacing
  'ODDS3001', // BrokenBinding
  'ODDS3002', // StaleBinding
  'ODDS3003', // ReimplementedBoundComponent
  'ODDS3004', // UnverifiedBinding
  'ODDS4001', // InvalidOverride
  'ODDS4002', // DanglingComponentReference
  'ODDS4003', // ReferenceCycle
  'ODDS4004', // ReferencedComponentDelete
  'ODDS4005', // InvalidPropMapping
  'ODDS4006', // ForbiddenDetach
  'ODDS4007', // ReferenceTraversalLimit
  'ODDS5001', // DesignSystemVersionMismatch
  'ODDS5002', // BreakingUpgradeWithoutMigration
  'ODDS5003', // MissingLockedDesignSystemVersion
  'ODDS5004', // DesignSystemPackageIntegrity
  'ODDS5005', // DesignSystemSourceIntegrity
  'ODDS5006', // ImmutableDesignSystemVersion
  'ODDS5007', // InvalidDesignSystemPackage
  'ODDS7001', // UnsupportedHandoffOutput
  'ODDS7002', // CodePackageCompatibility
  'ODDS7003', // MissingInstalledPackageEvidence
  'ODDS7004', // ProjectCodeSourceProof
]);
export type DesignDiagnosticCode = z.infer<typeof DesignDiagnosticCodeSchema>;

export const ValidationDiagnosticSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  code: DesignDiagnosticCodeSchema,
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string().min(1),
  nodeId: DesignEntityIdSchema.optional(),
  // Diagnostics can point to malformed/unknown references as well as valid ones.
  componentRef: z.string().min(1).optional(),
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])).optional(),
  allowedValues: z.array(JsonScalarSchema).optional(),
  suggestedFix: z.record(JsonObjectKeySchema, JsonValueSchema).optional(),
}).strict();
export type ValidationDiagnostic = z.infer<typeof ValidationDiagnosticSchema>;
