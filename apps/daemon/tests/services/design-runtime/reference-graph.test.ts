import { describe, expect, it } from 'vitest';
import { ComponentDeletionAnalysisSchema, ReferenceGraphQueryResultSchema, ReferenceGraphSchema } from '@open-design/contracts';
import { analyzeComponentDeletion, buildReferenceGraph, queryReferenceGraph } from '../../../src/services/design-runtime/reference-graph.js';
import { instance, projectComponentFixture } from '../../fixtures/design-runtime/project-components.js';

describe('project component reference graph', () => {
  it('finds direct and transitive users, screens, and complete outward dependency chains', () => {
    const input = projectComponentFixture();
    const graph = ReferenceGraphSchema.parse(buildReferenceGraph(input));
    expect(graph.diagnostics).toEqual([]);
    const result = ReferenceGraphQueryResultSchema.parse(queryReferenceGraph(input, 'local:Button'));
    expect(result.directUsages.map((edge) => [edge.owner, edge.nodeId])).toEqual([[{ kind: 'component', componentRef: 'local:ApplicationCard' }, 'card-button']]);
    expect(result.affectedScreens.map((owner) => owner.screenId)).toEqual(['Applications', 'Dashboard']);
    expect(result.transitiveUsages).toHaveLength(3);
    expect(result.chains.map((chain) => chain.map((edge) => edge.nodeId))).toEqual([['card-button', 'application'], ['card-button', 'dashboard']]);
    expect(ComponentDeletionAnalysisSchema.parse(analyzeComponentDeletion(input, 'local:Button')).canDelete).toBe(false);
    const ds = queryReferenceGraph(input, 'ds:acme/Button');
    expect(ds.chains.map((chain) => chain.map((edge) => edge.nodeId))).toEqual([['button-root', 'card-button', 'application'], ['button-root', 'card-button', 'dashboard']]);
  });

  it('uses actual references rather than allowed slot alternatives and remains deterministic under definition ordering', () => {
    const input = projectComponentFixture();
    const before = queryReferenceGraph(input, 'ds:acme/Button');
    input.projectComponents.components.reverse();
    expect(queryReferenceGraph(input, 'ds:acme/Button')).toEqual(before);
    expect(before.directUsages).toHaveLength(1);
  });

  it('does not certify deletion of an unknown target or with unrelated dangling references', () => {
    const input = projectComponentFixture();
    input.projectComponents.components.push({ schemaVersion: 1, id: 'Unused', name: 'Unused', revision: 1, props: {}, propMappings: [], template: { schemaVersion: 1, type: 'text', id: 'unused', text: 'hello' } });
    expect(analyzeComponentDeletion(input, 'local:Unused').canDelete).toBe(true);
    input.document.screens[0]!.children.push(instance('broken', 'local:Missing'));
    expect(analyzeComponentDeletion(input, 'local:Unused')).toMatchObject({ canDelete: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS4002' })]) });
    expect(analyzeComponentDeletion(projectComponentFixture(), 'local:Missing').canDelete).toBe(false);
  });

  it('reports stable closed cycle witnesses and terminates chain traversal', () => {
    const input = projectComponentFixture();
    input.projectComponents.components = ['A', 'B'].map((id, index) => ({ schemaVersion: 1, id, name: id, revision: 1, props: {}, propMappings: [], template: instance(`node-${id}`, index ? 'local:A' : 'local:B') }));
    input.document.screens = [];
    const query = ReferenceGraphQueryResultSchema.parse(queryReferenceGraph(input, 'local:A'));
    expect(query.cycles).toEqual([['local:A', 'local:B', 'local:A']]);
    expect(query.diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS4003' }));
    expect(analyzeComponentDeletion(input, 'local:A').canDelete).toBe(false);
  });

  it('reports incomplete traversal explicitly and never marks bounded analysis safe', () => {
    const input = projectComponentFixture();
    const result = ReferenceGraphQueryResultSchema.parse(queryReferenceGraph(input, 'local:Button', { maxChains: 1 }));
    expect(result.chains).toHaveLength(1);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS4007' }));
    expect(analyzeComponentDeletion(input, 'local:Button', { maxNodes: 1 }).canDelete).toBe(false);
    expect(() => buildReferenceGraph(input, { maxNodes: 0 })).toThrow(RangeError);
  });
});
