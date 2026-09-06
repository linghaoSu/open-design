import { z } from 'zod';
import { DesignEntityIdSchema, DesignRuntimeSchemaVersionSchema } from './common.js';
import { DesignGenerationReportSchema, type DesignGenerationReport } from './design-generation.js';

/** Daemon-issued logical task state. A report alone never establishes physical delivery. */
export interface DesignGenerationTaskProjection {
  schemaVersion: 1;
  executionId: string;
  projectId: string;
  conversationId: string | null;
  initialRunId: string;
  activeRunId: string;
  /** Authorized successor when viewed from a predecessor Run, including after completion. */
  nextRunId: string | null;
  /** Attempt of the current authorized physical Run, not of a historical message row. */
  attempt: 0 | 1;
  repairLimit: 1;
  status: 'running' | 'repairing' | 'awaiting_input' | 'succeeded' | 'blocked' | 'canceled';
  latestReport: DesignGenerationReport | null;
}
export const DesignGenerationTaskProjectionSchema: z.ZodType<DesignGenerationTaskProjection> = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema, executionId: DesignEntityIdSchema, projectId: DesignEntityIdSchema,
  conversationId: DesignEntityIdSchema.nullable(), initialRunId: DesignEntityIdSchema, activeRunId: DesignEntityIdSchema,
  nextRunId: DesignEntityIdSchema.nullable(), attempt: z.union([z.literal(0), z.literal(1)]), repairLimit: z.literal(1),
  status: z.enum(['running', 'repairing', 'awaiting_input', 'succeeded', 'blocked', 'canceled']), latestReport: DesignGenerationReportSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.nextRunId && value.nextRunId !== value.activeRunId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nextRunId'], message: 'A successor must be the current authorized Run.' });
  if (value.latestReport && (value.latestReport.executionId !== value.executionId || value.latestReport.attempt > value.attempt)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['latestReport'], message: 'The report must belong to this logical execution and an authorized attempt.' });
  if (value.status === 'repairing' && value.attempt !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attempt'], message: 'Repairing requires the single claimed repair attempt.' });
  if (value.status === 'awaiting_input' && (!value.latestReport || value.latestReport.runId !== value.activeRunId || value.latestReport.attempt !== value.attempt || !['accepted', 'not_applicable', 'advisory'].includes(value.latestReport.decision))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'Waiting requires a current passing stage report; any historical successor identifies that existing waiting Run, not a new attempt.' });
  if (value.status === 'succeeded' && (!value.latestReport || value.latestReport.runId !== value.activeRunId || value.latestReport.attempt !== value.attempt || !['accepted', 'not_applicable', 'advisory'].includes(value.latestReport.decision))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'Successful delivery requires a passing or Explore-advisory report and daemon-observed physical success.' });
});
