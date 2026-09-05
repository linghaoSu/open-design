import { DesignBenchmarkCaseSchema, DesignBenchmarkResultSchema, type DesignBenchmarkCase, type DesignBenchmarkResult } from '@open-design/contracts';
import { canonicalDesignSystemJson } from './design-system-version.js';
import { validateStructuredDesign } from './design-validation.js';

/** Measures deterministic fixture evaluation; no model calls, clocks or invented generation statistics. */
export function benchmarkStructuredDesign(cases: readonly DesignBenchmarkCase[], repeats = 3): DesignBenchmarkResult {
  if (!Number.isInteger(repeats) || repeats < 2 || repeats > 100) throw new Error('Benchmark repeats must be between 2 and 100.');
  const ids = new Set<string>();
  const reports = cases.map((raw) => {
    const fixture = DesignBenchmarkCaseSchema.parse(raw);
    if (ids.has(fixture.id)) throw new Error('Benchmark fixture IDs must be unique.');
    ids.add(fixture.id);
    const runs = Array.from({ length: repeats }, (_, index) => {
      const evaluate = (request: DesignBenchmarkCase['request']) => validateStructuredDesign({ ...request, sources: index % 2 ? [...request.sources].reverse() : request.sources });
      const initial = evaluate(fixture.request);
      const repairs = fixture.repairSteps.map((step) => ({ reason: step.reason, result: evaluate(step.request) }));
      return { initial, repairs, final: repairs.at(-1)?.result ?? initial };
    });
    const first = runs[0]!; const serialized = canonicalDesignSystemJson(first);
    const values = runs.map((run) => [run.initial, ...run.repairs.map((repair) => repair.result)].flatMap(({ metrics }) => [metrics.unknownComponents, metrics.unknownTokens, metrics.rawColors, metrics.rawSpacing, metrics.rawRadius, metrics.duplicateControls, metrics.duplicateStructures, metrics.intrinsicControls, metrics.unsupported, metrics.unresolvedImports, metrics.componentReuse.reused, metrics.componentReuse.total, metrics.bindingReuse.reused, metrics.bindingReuse.total]));
    const variance = values[0]!.reduce((sum, _, column) => {
      const mean = values.reduce((total, row) => total + row[column]!, 0) / repeats;
      return sum + values.reduce((total, row) => total + (row[column]! - mean) ** 2, 0) / repeats;
    }, 0);
    return { id: fixture.id, task: fixture.task, ...first, repairSteps: first.repairs.length, repeatable: runs.every((run) => canonicalDesignSystemJson(run) === serialized), repeats, metricVariance: variance };
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return DesignBenchmarkResultSchema.parse({ schemaVersion: 1, cases: reports, repeatable: reports.every((report) => report.repeatable), generationVariance: null });
}
