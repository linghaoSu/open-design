import { randomUUID } from 'node:crypto';
import type {
  ProjectComponentDefinition, ProjectDesignRuntimeDocumentResponse, ProjectDesignRuntimePublishComponentResponse,
  ProjectDesignRuntimeResponse, ProjectDesignRuntimeStageComponentResponse, ProjectDesignRuntimeValidateResponse,
  ProjectDesignRuntimePublishVersionResponse, ProjectDesignRuntimeVersionResponse, ProjectDesignRuntimeDependencyResponse,
  UIIRDocument,
} from '@open-design/contracts';
import { expect, test } from '@/playwright/suite';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

test('[P1] structured components compile, publish shared revisions and lock exact versions through the live workspace', async ({ page }, testInfo) => {
  await applyStandardMocks(page);
  await page.setViewportSize({ width: 1600, height: 1100 });
  const projectId = `design-runtime-${randomUUID()}`;
  const project = await page.request.post('/api/projects', {
    data: { id: projectId, name: 'Structured component acceptance', skillId: null, designSystemId: null, metadata: { kind: 'prototype' } },
  });
  expect(project.ok(), await project.text()).toBeTruthy();
  const { conversationId } = await project.json() as { conversationId: string };
  const sourceContent = `interface ButtonProps {
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
}
export function Button({ variant = 'primary', disabled = false }: ButtonProps) {
  return <button disabled={disabled} data-variant={variant}>Continue</button>;
}`;
  const source = await page.request.post(`/api/projects/${projectId}/files`, {
    data: {
      name: 'Button.tsx',
      content: sourceContent,
    },
  });
  expect(source.ok(), await source.text()).toBeTruthy();

  const prefix = `/api/projects/${projectId}/design-runtime`;
  await page.goto(`/projects/${projectId}/conversations/${conversationId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('file-workspace')).toBeVisible({ timeout: T.medium });
  await page.getByTestId('design-runtime-entry').click();
  const panel = page.getByTestId('design-runtime-panel');
  await expect(panel).toBeVisible();
  await expect(panel).not.toContainText('designRuntime.');
  await expect(page.getByTestId('design-runtime-system-id')).toBeEnabled();
  await page.getByTestId('design-runtime-system-id').fill('acme');
  await page.getByTestId('design-runtime-source-path-0').selectOption('Button.tsx');
  await page.getByTestId('design-runtime-export-name-0').fill('Button');
  const compiledResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${prefix}/compile`);
  await page.getByTestId('design-runtime-compile').click();
  const compiled = await compiledResponse;
  expect(compiled.ok(), await compiled.text()).toBeTruthy();
  const { state } = await compiled.json() as ProjectDesignRuntimeResponse;
  expect(state.registry?.components).toHaveLength(1);
  const binding = state.bindings.bindings[0]!;
  expect(binding.status).toBe('bound');
  await expect(page.getByTestId('design-runtime-component-select')).toHaveValue(state.registry!.components[0]!.id);
  await expect(page.getByTestId('design-runtime-unbind')).toBeEnabled();

  const unboundResponse = page.waitForResponse((response) => response.request().method() === 'DELETE'
    && new URL(response.url()).pathname === `${prefix}/bindings/${encodeURIComponent(binding.id)}`);
  await page.getByTestId('design-runtime-unbind').click();
  const unbound = await unboundResponse;
  expect(unbound.ok(), await unbound.text()).toBeTruthy();
  expect((await unbound.json() as ProjectDesignRuntimeResponse).state.bindings.bindings[0]!.status).toBe('unbound');
  await expect(page.getByTestId('design-runtime-unbind')).toBeDisabled();

  const reboundResponse = page.waitForResponse((response) => response.request().method() === 'PUT'
    && new URL(response.url()).pathname === `${prefix}/bindings/${encodeURIComponent(binding.id)}`);
  await page.getByTestId('design-runtime-bind').click();
  const rebound = await reboundResponse;
  expect(rebound.ok(), await rebound.text()).toBeTruthy();
  const reboundState = (await rebound.json() as ProjectDesignRuntimeResponse).state;
  expect(reboundState.bindings.bindings[0]!.status).toBe('bound');

  await page.getByTestId('design-runtime-prop-include-variant').check();
  await page.getByTestId('design-runtime-prop-variant').fill('primary');
  const validatedResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${prefix}/validate`);
  await page.getByTestId('design-runtime-validate').click();
  const validated = await validatedResponse;
  expect(validated.ok(), await validated.text()).toBeTruthy();
  expect((await validated.json() as ProjectDesignRuntimeValidateResponse).diagnostics).toEqual([]);

  // Reopening crosses the browser/provider/HTTP/storage boundary; storage's own
  // restart and compare-and-swap invariants are covered by daemon-local tests.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('design-runtime-entry').click();
  await expect(page.getByTestId('design-runtime-component-select')).toHaveValue(state.registry!.components[0]!.id);
  await expect(page.getByTestId('design-runtime-unbind')).toBeEnabled();
  await expect(page.getByTestId('design-runtime-export-name-0')).toHaveValue('Button');
  const persisted = await page.request.get(prefix);
  expect(persisted.ok(), await persisted.text()).toBeTruthy();
  expect((await persisted.json() as ProjectDesignRuntimeResponse).state).toEqual(reboundState);

  const screenshotPath = testInfo.outputPath('structured-components.png');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach('Structured components entry and panel', { path: screenshotPath, contentType: 'image/png' });

  // Seed the reference chain through the public API, then exercise the shared
  // editor's stage/review/publish transition in the same real project/browser.
  let seedState = reboundState;
  const localButton: ProjectComponentDefinition = {
    schemaVersion: 1, id: 'localButton', name: 'Shared Button', revision: 1,
    props: { variant: { type: 'enum', values: ['primary', 'secondary'], required: false, default: 'primary' } },
    template: { schemaVersion: 1, type: 'component', id: 'button-root', ref: `ds:acme/${state.registry!.components[0]!.id}` },
    propMappings: [{ prop: 'variant', nodeId: 'button-root', path: ['props', 'variant'] }],
  };
  const applicationCard: ProjectComponentDefinition = {
    schemaVersion: 1, id: 'applicationCard', name: 'Application Card', revision: 1, props: {}, propMappings: [],
    template: { schemaVersion: 1, type: 'instance', id: 'card-button', ref: 'local:localButton', overrides: [] },
  };
  for (const definition of [localButton, applicationCard]) {
    const draftId = `initial-${definition.id}`;
    const staged = await page.request.post(`${prefix}/component-changes`, {
      data: { expectedRevision: seedState.revision, draftId, expectedDefinitionRevision: 0, definition },
    });
    expect(staged.ok(), await staged.text()).toBeTruthy();
    seedState = (await staged.json() as ProjectDesignRuntimeStageComponentResponse).state;
    const published = await page.request.post(`${prefix}/component-changes/${draftId}/publish`, {
      data: { expectedRevision: seedState.revision, expectedDefinitionRevision: 0 },
    });
    expect(published.ok(), await published.text()).toBeTruthy();
    seedState = (await published.json() as ProjectDesignRuntimePublishComponentResponse).state;
  }
  const document: UIIRDocument = { schemaVersion: 1, id: 'shared-screens', screens: [
    { schemaVersion: 1, type: 'screen', id: 'applications', name: 'Applications', children: [
      { schemaVersion: 1, type: 'instance', id: 'applications-card', ref: 'local:applicationCard', overrides: [] },
    ] },
    { schemaVersion: 1, type: 'screen', id: 'dashboard', name: 'Dashboard', children: [
      { schemaVersion: 1, type: 'instance', id: 'dashboard-card', ref: 'local:applicationCard', overrides: [] },
      { schemaVersion: 1, type: 'instance', id: 'dashboard-override', ref: 'local:localButton', overrides: [{ schemaVersion: 1, path: ['props', 'variant'], value: 'primary' }] },
    ] },
  ] };
  const savedDocument = await page.request.put(`${prefix}/document`, { data: { expectedRevision: seedState.revision, document } });
  expect(savedDocument.ok(), await savedDocument.text()).toBeTruthy();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('design-runtime-entry').click();
  await page.getByTestId('design-runtime-structure-tab').click();
  const structure = page.getByTestId('project-structure-panel');
  await expect(structure).not.toContainText('projectStructure.');
  await page.getByTestId('structure-component-localButton').click();
  await expect(page.getByTestId('structure-prop-default-0')).toHaveValue('primary');
  await page.getByTestId('structure-prop-default-0').fill('secondary');
  const stagedSharedResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${prefix}/component-changes`);
  await page.getByTestId('structure-stage').click();
  const stagedShared = await stagedSharedResponse;
  expect(stagedShared.ok(), await stagedShared.text()).toBeTruthy();
  const stagedChange = await stagedShared.json() as ProjectDesignRuntimeStageComponentResponse;
  expect(stagedChange.state.projectComponents.components.find((entry) => entry.id === 'localButton')!.props.variant!.default).toBe('primary');
  expect(stagedChange.impact.usages.affectedScreens.map((screen) => screen.screenId).sort()).toEqual(['applications', 'dashboard']);
  const impact = page.getByTestId('structure-impact');
  await expect(impact).toContainText('Applications');
  await expect(impact).toContainText('Dashboard');
  await expect(page.getByTestId('structure-publish')).toBeEnabled();
  await impact.scrollIntoViewIfNeeded();
  const impactScreenshot = testInfo.outputPath('shared-component-impact.png');
  await page.screenshot({ path: impactScreenshot, fullPage: true });
  await testInfo.attach('Shared component staged impact', { path: impactScreenshot, contentType: 'image/png' });

  const publishResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${prefix}/component-changes/${stagedChange.draft.id}/publish`);
  await page.getByTestId('structure-publish').click();
  const publishedShared = await publishResponse;
  expect(publishedShared.ok(), await publishedShared.text()).toBeTruthy();
  const publishedState = (await publishedShared.json() as ProjectDesignRuntimePublishComponentResponse).state;
  expect(publishedState.document).toEqual(document);
  const resolvedResponse = await page.request.get(`${prefix}/document/resolve`);
  expect(resolvedResponse.ok(), await resolvedResponse.text()).toBeTruthy();
  const resolved = (await resolvedResponse.json() as ProjectDesignRuntimeDocumentResponse).resolution;
  expect(resolved.diagnostics).toEqual([]);
  expect(resolved.document!.screens.flatMap((screen) => screen.children).map((node) => node.type === 'component' ? node.props?.variant : undefined)).toEqual(['secondary', 'secondary', 'primary']);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('design-runtime-entry').click();
  await page.getByTestId('design-runtime-structure-tab').click();
  await page.getByTestId('structure-component-localButton').click();
  await expect(page.getByTestId('structure-prop-default-0')).toHaveValue('secondary');
  const undoButton = page.getByTestId('structure-undo-1');
  await structure.locator('details').filter({ has: undoButton }).locator('summary').click();
  const undoResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${prefix}/project-components/localButton/undo`);
  await undoButton.click();
  const undo = await undoResponse;
  expect(undo.ok(), await undo.text()).toBeTruthy();
  const undoChange = await undo.json() as ProjectDesignRuntimeStageComponentResponse;
  expect(undoChange.draft.proposedDefinition.revision).toBe(3);
  expect(undoChange.state.projectComponents.components.find((entry) => entry.id === 'localButton')!.revision).toBe(2);
  await expect(page.getByTestId('structure-publish')).toBeEnabled();
  const undoPublishResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${prefix}/component-changes/${undoChange.draft.id}/publish`);
  await page.getByTestId('structure-publish').click();
  const undoPublished = await undoPublishResponse;
  expect(undoPublished.ok(), await undoPublished.text()).toBeTruthy();
  const undoState = (await undoPublished.json() as ProjectDesignRuntimePublishComponentResponse).state;
  expect(undoState.projectComponents.components.find((entry) => entry.id === 'localButton')!.props.variant!.default).toBe('primary');
  expect(undoState.sharedChanges.history.filter((entry) => entry.componentRef === 'local:localButton').map((entry) => entry.definition.revision)).toEqual([1, 2, 3]);
  expect(undoState.document).toEqual(document);

  // Publish and pin through the live version panel. New source and a newer
  // publication must leave the same project on its reviewed exact snapshot.
  await page.getByTestId('design-runtime-versions-tab').click();
  await page.getByTestId('versions-name').fill('Acme UI');
  await page.getByTestId('versions-version').fill('1.0.0');
  await page.getByTestId('versions-source-Button.tsx').check();
  const sourceRow = page.getByTestId('versions-source-Button.tsx').locator('..');
  const checkboxBounds = await page.getByTestId('versions-source-Button.tsx').boundingBox();
  const sourceNameBounds = await sourceRow.locator('code').boundingBox();
  const sourceRowBounds = await sourceRow.boundingBox();
  expect(checkboxBounds!.width).toBeLessThanOrEqual(20);
  expect(sourceNameBounds!.x + sourceNameBounds!.width).toBeLessThanOrEqual(sourceRowBounds!.x + sourceRowBounds!.width);
  const firstVersionResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${prefix}/versions/publish-current`);
  await page.getByTestId('versions-publish').click();
  const firstVersion = await firstVersionResponse;
  expect(firstVersion.ok(), await firstVersion.text()).toBeTruthy();
  const firstPublication = await firstVersion.json() as ProjectDesignRuntimePublishVersionResponse;
  expect(firstPublication.version.version).toBe('1.0.0');
  expect(firstPublication.state.lock.dependencies).toEqual([]);
  await page.getByTestId('versions-select').selectOption(JSON.stringify(['acme', '1.0.0']));
  await page.getByTestId('versions-range').fill('^1.0.0');
  const activateResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${prefix}/dependency`);
  await page.getByTestId('versions-activate').click();
  const activated = await activateResponse;
  expect(activated.ok(), await activated.text()).toBeTruthy();
  const lockedState = (await activated.json() as ProjectDesignRuntimeResponse).state;
  expect(lockedState.lock.dependencies).toEqual([{
    designSystemId: 'acme', version: '1.0.0', digest: firstPublication.version.digest,
    source: { type: 'bundle', digest: firstPublication.version.sourceDigest },
  }]);
  await expect(page.getByTestId('versions-lock')).toContainText('1.0.0');

  const changedSource = sourceContent.replace('>Continue</button>', '>Continue safely</button>');
  const sourceUpdate = await page.request.post(`/api/projects/${projectId}/files`, {
    data: { name: 'Button.tsx', content: changedSource },
  });
  expect(sourceUpdate.ok(), await sourceUpdate.text()).toBeTruthy();
  await page.getByTestId('versions-version').fill('1.1.0');
  const nextVersionResponse = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `${prefix}/versions/publish-current`);
  await page.getByTestId('versions-publish').click();
  const nextVersion = await nextVersionResponse;
  expect(nextVersion.ok(), await nextVersion.text()).toBeTruthy();
  const nextPublication = await nextVersion.json() as ProjectDesignRuntimePublishVersionResponse;
  expect(nextPublication.state.lock).toEqual(lockedState.lock);
  expect(nextPublication.version.sourceDigest).not.toBe(firstPublication.version.sourceDigest);
  for (const [version, content] of [['1.0.0', sourceContent], ['1.1.0', changedSource]] as const) {
    const response = await page.request.get(`${prefix}/versions/acme/${version}`);
    expect(response.ok(), await response.text()).toBeTruthy();
    expect((await response.json() as ProjectDesignRuntimeVersionResponse).version.package.source.files)
      .toContainEqual({ path: 'Button.tsx', encoding: 'utf8', content });
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('design-runtime-entry').click();
  await page.getByTestId('design-runtime-versions-tab').click();
  await expect(page.getByTestId('versions-lock')).toContainText('1.0.0');
  const resolveLockResponse = page.waitForResponse((response) => response.request().method() === 'GET'
    && new URL(response.url()).pathname === `${prefix}/dependency/resolve`);
  await page.getByTestId('versions-resolve').click();
  const resolvedLock = await resolveLockResponse;
  expect(resolvedLock.ok(), await resolvedLock.text()).toBeTruthy();
  const dependency = (await resolvedLock.json() as ProjectDesignRuntimeDependencyResponse).resolution;
  expect(dependency.ok).toBe(true);
  expect(dependency.versions.map((entry) => entry.package.version)).toEqual(['1.0.0']);
  expect(dependency.versions[0]!.sourceDigest).toBe(firstPublication.version.sourceDigest);
  await page.getByTestId('versions-select').selectOption(JSON.stringify(['acme', '1.1.0']));
  await expect(page.getByTestId('versions-refresh')).toBeEnabled();
  await expect(page.getByTestId('versions-activate')).toBeDisabled();
  const lockScreenshot = testInfo.outputPath('locked-design-system-version.png');
  await page.screenshot({ path: lockScreenshot, fullPage: true });
  await testInfo.attach('Exact locked design system with newer published version', { path: lockScreenshot, contentType: 'image/png' });

  const clearResponse = page.waitForResponse((response) => response.request().method() === 'DELETE'
    && new URL(response.url()).pathname === `${prefix}/dependency`);
  await page.getByTestId('versions-clear').click();
  const cleared = await clearResponse;
  expect(cleared.ok(), await cleared.text()).toBeTruthy();
  const clearedState = (await cleared.json() as ProjectDesignRuntimeResponse).state;
  expect(clearedState.lock.dependencies).toEqual([]);
  expect(clearedState.registry).toEqual(lockedState.registry);
  expect(clearedState.document).toEqual(document);
});
