import { randomUUID } from 'node:crypto';
import type { ProjectDesignRuntimeResponse, ProjectDesignRuntimeValidateResponse } from '@open-design/contracts';
import { expect, test } from '@/playwright/suite';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { T } from '@/timeouts';

test('[P1] project components compile, bind, validate and survive reopening through the live workspace', async ({ page }, testInfo) => {
  await applyStandardMocks(page);
  await page.setViewportSize({ width: 1600, height: 1100 });
  const projectId = `design-runtime-${randomUUID()}`;
  const project = await page.request.post('/api/projects', {
    data: { id: projectId, name: 'Structured component acceptance', skillId: null, designSystemId: null, metadata: { kind: 'prototype' } },
  });
  expect(project.ok(), await project.text()).toBeTruthy();
  const { conversationId } = await project.json() as { conversationId: string };
  const source = await page.request.post(`/api/projects/${projectId}/files`, {
    data: {
      name: 'Button.tsx',
      content: `interface ButtonProps {
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
}
export function Button({ variant = 'primary', disabled = false }: ButtonProps) {
  return <button disabled={disabled} data-variant={variant}>Continue</button>;
}`,
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
});
