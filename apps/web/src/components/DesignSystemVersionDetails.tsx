import type { ComponentPropDefinition, DesignConstraintPolicy, DesignConstraintSet, DesignSystemPackage, SourceProvenance } from '@open-design/contracts';
import { useT } from '../i18n';
import styles from './DesignSystemVersionsPanel.module.css';

export const constraintFields = ['unknownComponents', 'unknownProps', 'invalidVariants', 'invalidSlots', 'undeclaredTokens', 'rawColors', 'rawRadius', 'rawSpacing', 'customControls'] as const;
type Field = (typeof constraintFields)[number];
type Severity = DesignConstraintPolicy['unknownComponents'];
export const policyModes = ['explore', 'guided', 'strict'] as const;

function policy(severity: Severity): DesignConstraintPolicy {
  return { unknownComponents: severity, unknownProps: severity, invalidVariants: severity, invalidSlots: severity,
    tokens: { undeclared: severity }, rawCss: { colors: severity, radius: severity, spacing: severity }, interactiveHtml: { customControlsWhenBoundComponentExists: severity } };
}
export function initialVersionConstraints(): DesignConstraintSet {
  return { schemaVersion: 1, explore: policy('warning'), guided: policy('error'), strict: policy('error') };
}
function constraintValue(policy: DesignConstraintPolicy, key: Field): Severity {
  if (key === 'undeclaredTokens') return policy.tokens.undeclared;
  if (key === 'rawColors') return policy.rawCss.colors;
  if (key === 'rawRadius') return policy.rawCss.radius;
  if (key === 'rawSpacing') return policy.rawCss.spacing;
  if (key === 'customControls') return policy.interactiveHtml.customControlsWhenBoundComponentExists;
  return policy[key];
}
function setConstraint(policy: DesignConstraintPolicy, key: Field, value: Severity): DesignConstraintPolicy {
  if (key === 'undeclaredTokens') return { ...policy, tokens: { undeclared: value } };
  if (key === 'rawColors' || key === 'rawRadius' || key === 'rawSpacing') {
    const member = key === 'rawColors' ? 'colors' : key === 'rawRadius' ? 'radius' : 'spacing';
    return { ...policy, rawCss: { ...policy.rawCss, [member]: value } };
  }
  if (key === 'customControls') return { ...policy, interactiveHtml: { customControlsWhenBoundComponentExists: value } };
  return { ...policy, [key]: value };
}

export function VersionConstraintFields({ value, disabled = false, onChange }: { value: DesignConstraintSet; disabled?: boolean; onChange?: (value: DesignConstraintSet) => void }) {
  const t = useT();
  return <div className={styles.policies}>
    {policyModes.map((mode) => <fieldset key={mode} disabled={disabled || !onChange}>
      <legend>{t(`designVersions.${mode}`)}</legend>
      {constraintFields.map((key) => <label className={styles.field} key={key}>{t(`designVersions.${key}`)}
        {onChange ? <select data-testid={`versions-policy-${mode}-${key}`} value={constraintValue(value[mode], key)} disabled={mode === 'strict'}
          onChange={(event) => onChange({ ...value, [mode]: setConstraint(value[mode], key, event.target.value as Severity) })}>
          {(['off', 'warning', 'error'] as const).map((severity) => <option value={severity} key={severity}>{t(`designVersions.${severity}`)}</option>)}
        </select> : <span>{t(`designVersions.${constraintValue(value[mode], key)}`)}</span>}
      </label>)}
    </fieldset>)}
  </div>;
}

function SourceEvidence({ source }: { source: SourceProvenance | undefined }) {
  return source ? <div className={styles.muted}><code>{source.sourcePath}{source.line ? `:${source.line}` : ''}</code>{source.exportName ? ` · ${source.exportName}` : ''} · {source.kind}</div> : null;
}

function PropsList({ props }: { props: Record<string, ComponentPropDefinition> }) {
  const t = useT();
  return <ul>{Object.entries(props).map(([name, prop]) => <li key={name}>
    <strong>{name}</strong> · <code>{prop.type === 'enum' ? prop.values.map((value) => JSON.stringify(value)).join(' | ') : prop.type}</code>
    {' · '}{prop.required ? t('designRuntime.required') : t('designRuntime.optional')}
    {prop.default !== undefined ? <span> · {t('common.default')}: <code>{JSON.stringify(prop.default)}</code></span> : null}
    <SourceEvidence source={prop.source} />
  </li>)}</ul>;
}

/** Read-only authoring evidence; source file contents are deliberately absent from this view. */
export function DesignSystemVersionDetails({ value }: { value: DesignSystemPackage }) {
  const t = useT();
  return <div className={styles.details} data-testid="versions-contents">
    <h4>{t('designVersions.metadata')}</h4>
    <details><summary>{t('designRuntime.components')} ({value.registry.components.length})</summary>
      {value.registry.components.map((component) => <article key={component.id}>
        <h5>{component.name} · <code>{component.id}</code></h5>
        <SourceEvidence source={component.source} />
        {component.states?.length ? <p>{t('designVersions.states')}: {component.states.join(', ')}</p> : null}
        <PropsList props={component.props} />
        {Object.entries(component.slots ?? {}).map(([name, slot]) => <div key={name}><p><strong>{name}</strong> · {slot.accepts.join(', ')} · {slot.required ? t('designRuntime.required') : t('designRuntime.optional')} · {slot.multiple ? t('designRuntime.multiple') : t('designRuntime.single')}</p><SourceEvidence source={slot.source} /></div>)}
        {component.stories?.map((story) => <div key={story.id}><p>{story.name} · <code>{story.exportName}</code> · {Object.entries(story.args).map(([name, value]) => `${name}: ${JSON.stringify(value)}`).join(', ')}</p><SourceEvidence source={story.source} /></div>)}
      </article>)}
    </details>
    <details><summary>{t('designRuntime.codeComponent')} ({value.codeIndex.components.length})</summary>
      {value.codeIndex.components.map((component) => <article key={component.id}>
        <h5>{component.name} · <code>{component.id}</code></h5>
        <p><code>{component.sourcePath}</code> · {component.exportName} · {component.framework}</p>
        <SourceEvidence source={component.source} />
        {component.packageName ? <p>{t('designRuntime.packageName')}: <code>{component.packageName}</code></p> : null}
        <PropsList props={component.props} />
        {Object.entries(component.slots ?? {}).map(([name, slot]) => <div key={name}><p>{name} · {slot.kind} · {slot.required ? t('designRuntime.required') : t('designRuntime.optional')} · {slot.multiple ? t('designRuntime.multiple') : t('designRuntime.single')}</p><SourceEvidence source={slot.source} /></div>)}
      </article>)}
    </details>
    <details><summary>{t('designRuntime.binding')} ({value.bindings.bindings.length})</summary>
      <ul>{value.bindings.bindings.map((binding) => <li key={binding.id}><code>{binding.componentRef}</code> → <code>{'codeComponentId' in binding ? binding.codeComponentId : t('common.none')}</code> · {t(`designRuntime.status.${binding.status}`)}
        <SourceEvidence source={binding.source} />
        {binding.propMappings?.length ? <><h5>{t('designRuntime.propMappings')}</h5>{binding.propMappings.map((mapping) => <p key={mapping.designProp}>{mapping.designProp} → {mapping.codeProp}{mapping.values ? ` · ${JSON.stringify(mapping.values)}` : ''}</p>)}</> : null}
        {binding.slotMappings?.map((mapping) => <div key={mapping.designSlot}><p>{mapping.designSlot} → {mapping.codeSlot}</p><SourceEvidence source={mapping.source} /></div>)}
      </li>)}</ul>
    </details>
    <details><summary>{t('designVersions.tokens')} ({value.tokens.tokens.length})</summary>
      <ul>{value.tokens.tokens.map((token) => <li key={token.id}><strong>{token.name}</strong> · <code>{token.id}</code> · {token.type} · <code>{JSON.stringify(token.value)}</code>{'unit' in token ? token.unit : ''} · <code>{token.cssVariable}</code></li>)}</ul>
    </details>
    <details><summary>{t('designVersions.patterns')} ({value.patterns.patterns.length})</summary>
      {value.patterns.patterns.map((pattern) => <article key={pattern.id}><h5>{pattern.name} · <code>{pattern.id}</code></h5><PropsList props={pattern.props} />
        {Object.entries(pattern.slots).map(([name, slot]) => <p key={name}>{name}: {slot.accepts.join(', ')} · {slot.required ? t('designRuntime.required') : t('designRuntime.optional')}</p>)}
      </article>)}
    </details>
    <details><summary>{t('designVersions.constraints')}</summary><VersionConstraintFields value={value.constraints} /></details>
    <details><summary>{t('designVersions.codeCompatibility')}</summary><ul>{value.codeCompatibility.map((entry) => <li key={`${entry.framework}:${entry.packageName}`}>{entry.framework} · {entry.packageName} · {entry.version}</li>)}</ul></details>
    <details><summary>{t('designVersions.sourceEvidence')} ({value.source.files.length})</summary><ul>{value.source.files.map((file) => <li key={file.path}><code>{file.path}</code> · {file.encoding}</li>)}</ul></details>
  </div>;
}
