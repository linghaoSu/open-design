import { describe, expect, it } from 'vitest';
import { composeSystemPrompt as composeContracts, renderDesignGenerationDirective, OD_NEXT_PROMPT_STAGE_CONTRACT_V2, ProjectDesignRuntimePreviewRequestSchema, type OdNextStrategyRequestRecipeV2 } from '@open-design/contracts';
import { composeSystemPrompt } from '../../src/prompts/system.js';
import { generationExecutionFixture } from '../fixtures/design-runtime/design-generation.js';

const execution = generationExecutionFixture();
const facts = { policy: execution.policy, targets: { schemaVersion: 1 as const, outputs: [{ sourcePath: 'Screen.vue', screenId: 'screen' }] } };
const recipe: OdNextStrategyRequestRecipeV2 = {
  recipe: 'od-next-plan-build-v2', strategyId: 'od-next-strategy', strategyVersion: '2.0.0', snapshotId: 'snapshot',
  packageHash: 'a'.repeat(64), taskProfileDigest: 'b'.repeat(64), taskProfileVersion: '2.0.0', taskType: 'prototype', executionProfile: 'filesystem',
  coreStrategy: '# Core\nPreserve task identity.', generalOrchestration: '# Orchestration\nPrepare a plan.', taskSkill: '# Prototype\nBuild the screen.',
  activeStages: OD_NEXT_PROMPT_STAGE_CONTRACT_V2.map((stage) => ({ name: stage.id, atoms: stage.atoms.map((name) => ({ name })) })),
};
describe('shared design generation prompt facts', () => {
  it.each(['classic', 'slim', 'contracts', 'od-next-daemon', 'od-next-contracts'] as const)('carries the same frozen policy on %s', (variant) => {
    const prompt = variant === 'contracts' ? composeContracts({ designGenerationFacts: facts })
      : variant === 'od-next-contracts' ? composeContracts({ odNextStrategyRecipe: recipe, designGenerationFacts: facts })
      : composeSystemPrompt({ designGenerationFacts: facts, ...(variant === 'od-next-daemon' ? { odNextStrategyRecipe: recipe } : variant === 'classic' || variant === 'slim' ? { promptCoreVariant: variant } : {}) });
    const directive = renderDesignGenerationDirective(facts);
    expect(prompt).toContain(directive); expect(prompt.split('## Host design generation policy')).toHaveLength(2);
    expect(prompt).toContain(execution.policy.digest); expect(prompt).toContain('Screen.vue');
    expect(prompt).toContain('All added or modified UI and CSS sources');
    const ordered = ['1. Resolve', '2. Author semantic UI IR', '3. Save generation-targets', '4. Generate React/Vue', '5. Run validate-artifacts', '6. Request preview'];
    const positions = ordered.map((step) => prompt.indexOf(step));
    expect(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!))).toBe(true);
    expect(prompt).toContain('Strict only:');
    expect(prompt).toContain('kind production-handoff');
    expect(ProjectDesignRuntimePreviewRequestSchema.safeParse({ expectedRevision: 0, id: 'preview', framework: 'react', kind: 'production-handoff', screenIds: ['screen'] }).success).toBe(true);
  });
  it('does not add host claims when no execution facts were supplied', () => {
    expect(renderDesignGenerationDirective()).toBe(''); expect(composeSystemPrompt({})).not.toContain('## Host design generation policy');
  });
});
