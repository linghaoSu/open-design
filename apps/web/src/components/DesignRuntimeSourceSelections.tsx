import { useId } from 'react';
import { Button, Input, Select } from '@open-design/components';
import type { ProjectDesignRuntimeCompileRequest } from '@open-design/contracts';
import { useT } from '../i18n';
import styles from './SourceSelections.module.css';

type Selection = ProjectDesignRuntimeCompileRequest['selections'][number];
type StorySource = NonNullable<Selection['storySources']>[number];
const newStory = () => ({ id: `story-${crypto.randomUUID()}`, exportName: '' });
function frameworkChange(selection: Selection, framework: 'react' | 'vue'): Partial<Selection> {
  return { framework, ...(framework === 'vue' ? { exportName: 'default' }
    : selection.framework === 'vue' && selection.exportName === 'default' ? { exportName: '' } : {}) };
}

/** All source and story identities are explicit; editing source labels never reallocates them. */
export function DesignRuntimeSourceSelections({ selections, files, onChange, allowEmpty = false }: { selections: Selection[]; files: readonly string[]; onChange(value: Selection[]): void; allowEmpty?: boolean }) {
  const t = useT();
  const hintId = useId();
  function update(index: number, value: Partial<Selection>) { onChange(selections.map((selection, position) => position === index ? { ...selection, ...value } : selection)); }
  function updateSources(index: number, sources: StorySource[]) { update(index, { storySources: sources.length ? sources : undefined }); }
  return <>{selections.map((selection, index) => {
    const framework = selection.framework ?? 'react';
    const sourceFiles = files.filter((path) => /\.(vue|ts|tsx)$/i.test(path) && !/\.d\.ts$/i.test(path));
    const storyFiles = files.filter((path) => /\.(ts|tsx)$/.test(path) && !path.endsWith('.d.ts'));
    return <div className={styles.source} key={selection.componentId}>
      <div className={styles.essentials}>
      <label className={styles.field}>{t('designRuntime.sourcePath')}
        <Select data-testid={`design-runtime-source-path-${index}`} value={selection.sourcePath} required onChange={(event) => {
          const sourcePath = event.target.value;
          update(index, { sourcePath, ...(sourcePath ? frameworkChange(selection, /\.vue$/i.test(sourcePath) ? 'vue' : 'react') : {}) });
        }}>
          <option value="">{t('designRuntime.chooseSource')}</option>
          {selection.sourcePath && !sourceFiles.includes(selection.sourcePath) ? <option value={selection.sourcePath}>{selection.sourcePath}</option> : null}
          {sourceFiles.map((path) => <option key={path} value={path}>{path}</option>)}
        </Select>
      </label>
      <label className={styles.field}>{t('designRuntime.exportName')}
        <Input data-testid={`design-runtime-export-name-${index}`} value={selection.exportName} required readOnly={framework === 'vue'} placeholder={framework === 'vue' ? 'default' : 'Button'} aria-describedby={`${hintId}-${index}`} pattern="[A-Za-z_$][A-Za-z0-9_$]*" onChange={(event) => update(index, { exportName: event.target.value })} />
      </label>
      </div>
      <p className={styles.muted} id={`${hintId}-${index}`}>{t('designWorkspace.exportHint')}</p>
      <details className={styles.advanced} data-testid={`design-runtime-source-advanced-${index}`}><summary>{t('designWorkspace.advanced')}</summary>
      <label className={styles.field}>{t('designRuntime.framework')}
        <Select data-testid={`design-runtime-framework-${index}`} value={framework} onChange={(event) => update(index, frameworkChange(selection, event.target.value as 'react' | 'vue'))}>
          <option value="react">React</option><option value="vue">Vue</option>
        </Select>
      </label>
      <label className={styles.field}>{t('designRuntime.metadataExport')}
        <Input data-testid={`design-runtime-metadata-export-${index}`} value={selection.metadataExportName ?? ''} pattern="[A-Za-z_$][A-Za-z0-9_$]*" onChange={(event) => update(index, { metadataExportName: event.target.value || undefined })} />
      </label>
      <p className={styles.muted}>{t('designRuntime.metadataHint')}</p>
      <details><summary>{t('designRuntime.identities')}</summary>
        <p className={styles.muted}>{t('designRuntime.identityHint')}</p>
        <label className={styles.field}>{t('designRuntime.componentId')}<Input data-testid={`design-runtime-component-id-${index}`} value={selection.componentId} readOnly /></label>
        <label className={styles.field}>{t('designRuntime.codeId')}<Input data-testid={`design-runtime-code-id-${index}`} value={selection.codeComponentId} readOnly /></label>
        <label className={styles.field}>{t('designRuntime.packageName')}<Input value={selection.packageName ?? ''} onChange={(event) => update(index, { packageName: event.target.value || undefined })} /></label>
      </details>
      <details open={!!selection.storySources?.length}><summary>{t('designRuntime.stories')}</summary>
        <p className={styles.muted}>{t('designRuntime.storyHint')}</p>
        {(selection.storySources ?? []).map((source, sourceIndex) => <fieldset className={styles.storySource} key={sourceIndex}>
          <label className={styles.field}>{t('designRuntime.storySource')}
            <Select data-testid={`design-runtime-story-source-${index}-${sourceIndex}`} value={source.sourcePath} required onChange={(event) => updateSources(index, selection.storySources!.map((entry, position) => position === sourceIndex ? { ...entry, sourcePath: event.target.value } : entry))}>
              <option value="">{t('designRuntime.chooseSource')}</option>
              {source.sourcePath && !storyFiles.includes(source.sourcePath) ? <option value={source.sourcePath}>{source.sourcePath}</option> : null}
              {storyFiles.map((path) => <option key={path} value={path}>{path}</option>)}
            </Select>
          </label>
          {source.selections.map((story, storyIndex) => <div className={styles.story} key={story.id}>
            <label className={styles.field}>{t('designRuntime.storyExport')}<Input data-testid={`design-runtime-story-export-${index}-${sourceIndex}-${storyIndex}`} value={story.exportName} required pattern="[A-Za-z_$][A-Za-z0-9_$]*"
              onChange={(event) => updateSources(index, selection.storySources!.map((entry, position) => position === sourceIndex ? { ...entry, selections: entry.selections.map((selected, position) => position === storyIndex ? { ...selected, exportName: event.target.value } : selected) } : entry))} /></label>
            <label className={styles.field}>{t('designRuntime.storyId')}<Input data-testid={`design-runtime-story-id-${index}-${sourceIndex}-${storyIndex}`} value={story.id} readOnly /></label>
            <Button variant="ghost" disabled={source.selections.length === 1} onClick={() => updateSources(index, selection.storySources!.map((entry, position) => position === sourceIndex ? { ...entry, selections: entry.selections.filter((_, position) => position !== storyIndex) } : entry))}>{t('common.delete')}</Button>
          </div>)}
          <div className={styles.actions}>
            <Button data-testid={`design-runtime-add-story-${index}-${sourceIndex}`} onClick={() => updateSources(index, selection.storySources!.map((entry, position) => position === sourceIndex ? { ...entry, selections: [...entry.selections, newStory()] } : entry))}>{t('designRuntime.addStory')}</Button>
            <Button variant="ghost" onClick={() => updateSources(index, selection.storySources!.filter((_, position) => position !== sourceIndex))}>{t('common.delete')}</Button>
          </div>
        </fieldset>)}
        <Button data-testid={`design-runtime-add-story-source-${index}`} onClick={() => updateSources(index, [...selection.storySources ?? [], { sourcePath: '', selections: [newStory()] }])}>{t('designRuntime.addStorySource')}</Button>
      </details>
      </details>
      <Button variant="ghost" disabled={!allowEmpty && selections.length === 1} aria-label={`${t('common.delete')} ${index + 1}`} onClick={() => onChange(selections.filter((_, position) => position !== index))}>{t('common.delete')}</Button>
    </div>;
  })}</>;
}
