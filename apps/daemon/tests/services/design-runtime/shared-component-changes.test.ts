import { describe, expect, it } from 'vitest';
import type { ComponentInstance, ProjectComponentDefinition, SharedComponentChangeState, UIIRNode } from '@open-design/contracts';
import {
  discardSharedComponentChange,
  getSharedComponentHistory,
  inspectSharedComponentChange,
  publishSharedComponentChange,
  recordSharedComponentRegistryChange,
  SharedComponentChangeError,
  stageSharedComponentChange,
  stageSharedComponentUndo,
  type SharedComponentContext,
} from '../../../src/services/design-runtime/shared-component-changes.js';
import { deleteProjectComponent, resolveProjectDocument } from '../../../src/services/design-runtime/project-components.js';
import { flattenNodes, instance, projectComponentFixture } from '../../fixtures/design-runtime/project-components.js';

function emptyChanges(): SharedComponentChangeState { return { schemaVersion: 1, id: 'project', drafts: [], history: [] }; }
function proposal(input: SharedComponentContext, id = 'Button'): ProjectComponentDefinition {
  const current = structuredClone(input.projectComponents.components.find((component) => component.id === id)!);
  current.revision++;
  if (id === 'Button') {
    current.props.variant!.default = 'secondary';
    current.props.label!.default = 'Save';
  }
  return current;
}
function buttonProps(nodes: UIIRNode[]) {
  return flattenNodes(nodes).flatMap((node) => node.type === 'component' && node.ref === 'ds:acme/Button' ? [node.props] : []);
}
function expectChangeError(action: () => unknown, code: SharedComponentChangeError['code']): SharedComponentChangeError {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(SharedComponentChangeError);
  expect(caught).toMatchObject({ code });
  return caught as SharedComponentChangeError;
}

describe('staged shared component revisions', () => {
  it('calculates nested usages and before/proposed inheritance without mutating live state', () => {
    const input = projectComponentFixture();
    const changes = emptyChanges();
    const original = structuredClone({ input, changes });
    const request = { draftId: 'button-edit', expectedDefinitionRevision: 1, definition: proposal(input) };
    const result = stageSharedComponentChange(input, changes, request);
    expect(result.impact.diagnostics).toEqual([]);
    expect(result.impact.usages.directUsages).toMatchObject([{ owner: { kind: 'component', componentRef: 'local:ApplicationCard' }, nodeId: 'card-button' }]);
    expect(result.impact.usages.transitiveUsages).toHaveLength(3);
    expect(result.impact.usages.affectedScreens.map((screen) => screen.screenId)).toEqual(['Applications', 'Dashboard']);
    expect(result.impact.current.document!.screens.map((screen) => buttonProps(screen.children)[0]?.variant)).toEqual(['primary', 'secondary']);
    expect(result.impact.proposed.document!.screens.map((screen) => buttonProps(screen.children)[0])).toEqual([
      { variant: 'secondary', label: 'Save', disabled: false }, { variant: 'secondary', label: 'Save', disabled: false },
    ]);
    expect(result.changes.history).toEqual([]);
    expect({ input, changes }).toEqual(original);
    expect(stageSharedComponentChange(input, changes, request)).toEqual(result);
  });

  it('publishes one new definition revision and immutable history while keeping source overrides unchanged', () => {
    const input = projectComponentFixture();
    const original = structuredClone(input);
    const staged = stageSharedComponentChange(input, emptyChanges(), { draftId: 'button-edit', expectedDefinitionRevision: 1, definition: proposal(input) });
    const published = publishSharedComponentChange(input, staged.changes, { draftId: 'button-edit', expectedDefinitionRevision: 1 });
    expect(published.projectComponents.components.find((component) => component.id === 'Button')!.revision).toBe(2);
    expect(published.projectComponents.components.find((component) => component.id === 'ApplicationCard')!.revision).toBe(1);
    expect(published.changes.drafts).toEqual([]);
    expect(published.changes.history.map((entry) => [entry.definition.revision, entry.changeId])).toEqual([[1, null], [2, 'button-edit']]);
    expect(resolveProjectDocument({ ...input, projectComponents: published.projectComponents })).toEqual(published.impact.proposed);
    expect(input).toEqual(original);
    expect(staged.changes.drafts).toHaveLength(1);
    const history = getSharedComponentHistory(published.changes, 'local:Button');
    history[0]!.definition.props.label!.default = 'Attempted history mutation';
    expect(published.changes.history[0]!.definition.props.label!.default).toBe('Apply');
  });

  it('stores invalid override impact for review and rejects publication atomically', () => {
    const input = projectComponentFixture();
    const definition = proposal(input, 'ApplicationCard');
    definition.props.variant = { type: 'enum', values: ['primary'], required: false };
    const staged = stageSharedComponentChange(input, emptyChanges(), { draftId: 'card-narrow', expectedDefinitionRevision: 1, definition });
    expect(staged.impact.proposed.document).toBeNull();
    expect(staged.impact.diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS1003', nodeId: 'dashboard' }));
    const before = structuredClone({ input, changes: staged.changes });
    const error = expectChangeError(() => publishSharedComponentChange(input, staged.changes, { draftId: 'card-narrow', expectedDefinitionRevision: 1 }), 'VALIDATION_FAILED');
    expect(error.impact).toEqual(staged.impact);
    expect({ input, changes: staged.changes }).toEqual(before);
  });

  it('recomputes impact at inspection and publish to include instances added after staging', () => {
    const input = projectComponentFixture();
    const staged = stageSharedComponentChange(input, emptyChanges(), { draftId: 'button-edit', expectedDefinitionRevision: 1, definition: proposal(input) });
    input.document.screens.push({ schemaVersion: 1, type: 'screen', id: 'Later', children: [instance('later-card', 'local:ApplicationCard', 'invalid')] });
    const inspected = inspectSharedComponentChange(input, staged.changes, 'button-edit');
    expect(inspected.usages.affectedScreens.map((screen) => screen.screenId)).toContain('Later');
    expect(inspected.diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS1003', nodeId: 'later-card' }));
    expectChangeError(() => publishSharedComponentChange(input, staged.changes, { draftId: 'button-edit', expectedDefinitionRevision: 1 }), 'VALIDATION_FAILED');
    expect(staged.impact.diagnostics).toEqual([]);
  });

  it('validates unused definition mapping domains when the project has no document', () => {
    const input: SharedComponentContext = { ...projectComponentFixture(), document: null };
    const definition = proposal(input);
    definition.props.variant = { type: 'enum', values: ['primary', 'danger'], required: false, default: 'primary' };
    const staged = stageSharedComponentChange(input, emptyChanges(), { draftId: 'bad-domain', expectedDefinitionRevision: 1, definition });
    expect(staged.impact.diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS4005' }));
    expectChangeError(() => publishSharedComponentChange(input, staged.changes, { draftId: 'bad-domain', expectedDefinitionRevision: 1 }), 'VALIDATION_FAILED');
    expect(input.document).toBeNull();
  });

  it('rejects a proposed local root that violates the containing screen slot grammar', () => {
    const input = projectComponentFixture();
    const plain = { ...input.projectComponents.components[0]!, props: {}, propMappings: [] };
    input.projectComponents.components = [plain];
    const frame = (id: string, child: UIIRNode): UIIRNode => ({ schemaVersion: 1, type: 'component', id, ref: 'ds:acme/Frame', slots: {
      heading: [{ schemaVersion: 1, type: 'text', id: `${id}-title`, text: 'Frame' }], body: [child],
    } });
    input.document.screens = [{ schemaVersion: 1, type: 'screen', id: 'Screen', children: [frame('outer', instance('wrapped', 'local:Button'))] }];
    const definition = { ...plain, revision: 2, template: frame('new-root', { schemaVersion: 1 as const, type: 'component' as const, id: 'inner-button', ref: 'ds:acme/Button' }) };
    const staged = stageSharedComponentChange(input, emptyChanges(), { draftId: 'root-change', expectedDefinitionRevision: 1, definition });
    expect(staged.impact.diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS1004', nodeId: 'wrapped' }));
    expectChangeError(() => publishSharedComponentChange(input, staged.changes, { draftId: 'root-change', expectedDefinitionRevision: 1 }), 'VALIDATION_FAILED');
  });

  it('fails closed when validation or graph traversal cannot complete', () => {
    const input = projectComponentFixture();
    const staged = stageSharedComponentChange(input, emptyChanges(), { draftId: 'limited', expectedDefinitionRevision: 1, definition: proposal(input) }, { maxNodes: 1 });
    expect(staged.impact.diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS4007' }));
    expectChangeError(() => publishSharedComponentChange(input, staged.changes, { draftId: 'limited', expectedDefinitionRevision: 1 }, { maxNodes: 1 }), 'VALIDATION_FAILED');
  });

  it('allows new definitions at revision 1 and can repair previously dangling instances', () => {
    const definition: ProjectComponentDefinition = { schemaVersion: 1, id: 'Message', name: 'Message', revision: 1, props: {}, propMappings: [], template: { schemaVersion: 1, id: 'text', type: 'text', text: 'Ready' } };
    const input: SharedComponentContext = {
      registry: null, projectComponents: { schemaVersion: 1, id: 'project', components: [] },
      document: { schemaVersion: 1, id: 'document', screens: [{ schemaVersion: 1, id: 'screen', type: 'screen', children: [instance('message', 'local:Message')] }] },
    };
    const staged = stageSharedComponentChange(input, emptyChanges(), { draftId: 'create-message', expectedDefinitionRevision: 0, definition });
    expect(staged.impact.current.document).toBeNull();
    expect(staged.impact.proposed.document).not.toBeNull();
    expect(staged.impact.diagnostics).toEqual([]);
    const published = publishSharedComponentChange(input, staged.changes, { draftId: 'create-message', expectedDefinitionRevision: 0 });
    expect(published.changes.history).toHaveLength(1);
    expect(published.changes.history[0]).toMatchObject({ changeId: 'create-message', definition: { revision: 1 } });
    expect(input.projectComponents.components).toEqual([]);
  });
});

describe('shared revision conflict, discard and undo', () => {
  it('rejects changed revisions and same-revision content drift but accepts object key reordering', () => {
    const input = projectComponentFixture();
    const staged = stageSharedComponentChange(input, emptyChanges(), { draftId: 'button-edit', expectedDefinitionRevision: 1, definition: proposal(input) });
    const reordered = structuredClone(input);
    const button = reordered.projectComponents.components[0]!;
    button.props = Object.fromEntries(Object.entries(button.props).reverse());
    expect(publishSharedComponentChange(reordered, staged.changes, { draftId: 'button-edit', expectedDefinitionRevision: 1 }).projectComponents.components[1]!.id).toBe('Button');
    const revised = structuredClone(input);
    revised.projectComponents.components[0]!.revision = 2;
    expectChangeError(() => publishSharedComponentChange(revised, staged.changes, { draftId: 'button-edit', expectedDefinitionRevision: 1 }), 'CONFLICT');
    const drifted = structuredClone(input);
    drifted.projectComponents.components[0]!.props.label!.default = 'Untracked change';
    expectChangeError(() => publishSharedComponentChange(drifted, staged.changes, { draftId: 'button-edit', expectedDefinitionRevision: 1 }), 'CONFLICT');
    expectChangeError(() => publishSharedComponentChange(input, staged.changes, { draftId: 'button-edit', expectedDefinitionRevision: 2 }), 'CONFLICT');
  });

  it('allows updating one draft, prevents competing identities, and discards without publishing', () => {
    const input = projectComponentFixture();
    const request = { draftId: 'button-edit', expectedDefinitionRevision: 1, definition: proposal(input) };
    const staged = stageSharedComponentChange(input, emptyChanges(), request);
    const updated = stageSharedComponentChange(input, staged.changes, { ...request, definition: { ...request.definition, name: 'Renamed' } });
    expect(updated.changes.drafts).toHaveLength(1);
    expect(updated.draft.proposedDefinition.name).toBe('Renamed');
    expectChangeError(() => stageSharedComponentChange(input, staged.changes, { ...request, draftId: 'competing' }), 'CONFLICT');
    expectChangeError(() => stageSharedComponentChange(input, staged.changes, { ...request, definition: proposal(input, 'ApplicationCard') }), 'CONFLICT');
    expect(discardSharedComponentChange(updated.changes, 'button-edit')).toEqual(emptyChanges());
    expect(updated.changes.drafts).toHaveLength(1);
    expectChangeError(() => discardSharedComponentChange(emptyChanges(), 'missing'), 'NOT_FOUND');
  });

  it('stages undo as a new monotonic revision and captures the baseline only once', () => {
    const input = projectComponentFixture();
    const staged = stageSharedComponentChange(input, emptyChanges(), { draftId: 'button-edit', expectedDefinitionRevision: 1, definition: proposal(input) });
    const published = publishSharedComponentChange(input, staged.changes, { draftId: 'button-edit', expectedDefinitionRevision: 1 });
    const current = { ...input, projectComponents: published.projectComponents };
    const oldHistory = structuredClone(published.changes.history);
    const undo = stageSharedComponentUndo(current, published.changes, { draftId: 'undo-button', componentRef: 'local:Button', expectedDefinitionRevision: 2, restoreDefinitionRevision: 1 });
    expect(undo.draft).toMatchObject({ source: { type: 'undo', definitionRevision: 1 }, proposedDefinition: { revision: 3, props: { label: { default: 'Apply' } } } });
    const restored = publishSharedComponentChange(current, undo.changes, { draftId: 'undo-button', expectedDefinitionRevision: 2 });
    expect(restored.changes.history.map((entry) => entry.definition.revision)).toEqual([1, 2, 3]);
    expect(restored.changes.history.slice(0, 2)).toEqual(oldHistory);
    expect(restored.impact.proposed.document!.screens.map((screen) => buttonProps(screen.children)[0]?.variant)).toEqual(['primary', 'secondary']);
    expect((input.document.screens[1]!.children[0] as ComponentInstance).overrides).toHaveLength(1);
    expect(published.changes.history).toEqual(oldHistory);
  });

  it('prevents published ID reuse, historical revision rewind, and missing-history undo', () => {
    const input = projectComponentFixture();
    const staged = stageSharedComponentChange(input, emptyChanges(), { draftId: 'button-edit', expectedDefinitionRevision: 1, definition: proposal(input) });
    const published = publishSharedComponentChange(input, staged.changes, { draftId: 'button-edit', expectedDefinitionRevision: 1 });
    const current = { ...input, projectComponents: published.projectComponents };
    expectChangeError(() => stageSharedComponentChange(current, published.changes, { draftId: 'button-edit', expectedDefinitionRevision: 2, definition: proposal(current) }), 'CONFLICT');
    expectChangeError(() => stageSharedComponentChange(input, published.changes, { draftId: 'rewind', expectedDefinitionRevision: 1, definition: proposal(input) }), 'CONFLICT');
    const untracked = structuredClone(current);
    untracked.projectComponents.components.find((definition) => definition.id === 'Button')!.revision = 3;
    expectChangeError(() => stageSharedComponentChange(untracked, published.changes, { draftId: 'untracked', expectedDefinitionRevision: 3, definition: proposal(untracked) }), 'CONFLICT');
    expectChangeError(() => stageSharedComponentUndo(current, emptyChanges(), { draftId: 'undo-missing', componentRef: 'local:Button', expectedDefinitionRevision: 2, restoreDefinitionRevision: 1 }), 'NOT_FOUND');
    const removed = { ...current, projectComponents: { ...current.projectComponents, components: [] } };
    expectChangeError(() => stageSharedComponentChange(removed, published.changes, { draftId: 'reuse-identity', expectedDefinitionRevision: 0, definition: input.projectComponents.components[0]! }), 'CONFLICT');
  });
});

describe('atomic history for explicit reference rewrites', () => {
  function deletionFixture() {
    const input = projectComponentFixture();
    input.projectComponents.components = [input.projectComponents.components[0]!, ...['A', 'B'].map((id) => ({
      schemaVersion: 1 as const, id, name: id, revision: 1, props: {}, propMappings: [], template: instance('shared-button', 'local:Button'),
    }))];
    input.document.screens = [{ schemaVersion: 1, type: 'screen', id: 'Screen', children: [instance('a', 'local:A'), instance('b', 'local:B')] }];
    const deleted = deleteProjectComponent(input, { componentRef: 'local:Button', action: { type: 'detach' } });
    if (!deleted.ok) throw new Error('Expected valid explicit detach');
    return { input, after: { ...input, projectComponents: deleted.projectComponents, document: deleted.document } };
  }

  it('revises all rewritten survivors together and preserves deleted and prior published snapshots', () => {
    const { input, after } = deletionFixture();
    const changes = emptyChanges();
    const original = structuredClone({ input, after, changes });
    const result = recordSharedComponentRegistryChange(input, after, changes, { 'local:A': 'delete-a', 'local:B': 'delete-b' });
    expect(result.projectComponents.components.map((definition) => [definition.id, definition.revision])).toEqual([['A', 2], ['B', 2]]);
    expect(result.changes.history.map((entry) => [entry.componentRef, entry.definition.revision, entry.changeId])).toEqual([
      ['local:A', 1, null], ['local:A', 2, 'delete-a'], ['local:B', 1, null], ['local:B', 2, 'delete-b'], ['local:Button', 1, null],
    ]);
    expect(result.resolved.diagnostics).toEqual([]);
    expect({ input, after, changes }).toEqual(original);
  });

  it('rejects final validation failures and pending affected drafts without changing any inputs', () => {
    const { input, after } = deletionFixture();
    const staged = stageSharedComponentChange(input, emptyChanges(), { draftId: 'pending-a', expectedDefinitionRevision: 1, definition: { ...input.projectComponents.components[1]!, revision: 2, name: 'Edited A' } });
    const before = structuredClone({ input, after, changes: staged.changes });
    expectChangeError(() => recordSharedComponentRegistryChange(input, after, staged.changes, { 'local:A': 'delete-a', 'local:B': 'delete-b' }), 'CONFLICT');
    expect({ input, after, changes: staged.changes }).toEqual(before);
    const invalid = structuredClone(after);
    invalid.document.screens[0]!.children.push(instance('missing', 'local:Missing'));
    expectChangeError(() => recordSharedComponentRegistryChange(input, invalid, emptyChanges(), { 'local:A': 'delete-a', 'local:B': 'delete-b' }), 'VALIDATION_FAILED');
    expect(after).toEqual(before.after);
  });

  it('rejects missing or colliding explicit rewrite IDs', () => {
    const { input, after } = deletionFixture();
    expectChangeError(() => recordSharedComponentRegistryChange(input, after, emptyChanges(), { 'local:A': 'only-a' }), 'CONFLICT');
    expectChangeError(() => recordSharedComponentRegistryChange(input, after, emptyChanges(), { 'local:A': 'duplicate', 'local:B': 'duplicate' }), 'CONFLICT');
  });
});
