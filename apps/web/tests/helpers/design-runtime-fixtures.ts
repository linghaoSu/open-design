import type { ProjectDesignRuntimeState } from '@open-design/contracts';

export function emptyDesignRuntimeState(revision = 0): ProjectDesignRuntimeState {
  return {
    schemaVersion: 1, revision, registry: null,
    codeIndex: { schemaVersion: 1, id: 'project', components: [] },
    bindings: { schemaVersion: 1, id: 'project', bindings: [] },
  };
}

export function designRuntimeState(revision = 1): ProjectDesignRuntimeState {
  const source = { kind: 'typescript' as const, sourcePath: 'src/Button.tsx', exportName: 'Button' };
  const props = {
    variant: { type: 'enum' as const, values: ['primary', 'secondary'], required: false, default: 'primary' },
    disabled: { type: 'boolean' as const, required: false, default: false },
  };
  return {
    schemaVersion: 1, revision,
    registry: { schemaVersion: 1, id: 'test', components: [{ schemaVersion: 1, id: 'button', name: 'Button', props, source }] },
    codeIndex: { schemaVersion: 1, id: 'project', components: [{
      schemaVersion: 1, id: 'code/Button', framework: 'react', name: 'Button', sourcePath: source.sourcePath,
      exportName: 'Button', props, source,
    }] },
    bindings: { schemaVersion: 1, id: 'project', bindings: [{
      schemaVersion: 1, id: 'button-binding', framework: 'react', componentRef: 'ds:test/button',
      status: 'bound', verified: true, codeComponentId: 'code/Button',
    }] },
  };
}
