import { Button } from '@open-design/components';
import type { ComponentRegistry, ProjectComponentDefinition, ProjectComponentPropMapping } from '@open-design/contracts';
import { useT } from '../i18n';
import { allNodes, freshId, type ComponentFormDraft, type PublicPropDraft, type ScalarDraft } from './project-structure-drafts';
import styles from './ProjectStructurePanel.module.css';

interface Props {
  value: ComponentFormDraft;
  registry: ComponentRegistry | null;
  localComponents: readonly ProjectComponentDefinition[];
  disabled: boolean;
  onChange(value: ComponentFormDraft): void;
}

export function PublicComponentPropsEditor({ value, registry, localComponents, disabled, onChange }: Props) {
  const t = useT();
  type MappingTarget = { label: string; nodeId: string; path: ProjectComponentPropMapping['path'] };
  const targets = value.template ? allNodes([value.template]).flatMap<MappingTarget>((node) => {
    if (node.type === 'text') return [{ label: `${node.id} · text`, nodeId: node.id, path: ['text'] as ['text'] }];
    const definition = registry?.components.find((component) => node.ref === `ds:${registry.id}/${component.id}`)
      ?? localComponents.find((component) => node.ref === `local:${component.id}`);
    return Object.keys(definition?.props ?? {}).map((name) => ({ label: `${node.id} · ${name}`, nodeId: node.id, path: ['props', name] as ['props', string] }));
  }) : [];
  const targetKey = (target: { nodeId: string; path: ProjectComponentPropMapping['path'] }) => JSON.stringify([target.nodeId, target.path]);
  const updateProp = (key: string, patch: Partial<PublicPropDraft>) => onChange({ ...value, props: value.props.map((prop) => prop.key === key ? { ...prop, ...patch } : prop) });
  return <section className={styles.card}>
    <h4>{t('projectStructure.publicProps')}</h4>
    {value.props.map((prop, index) => <fieldset className={styles.property} key={prop.key} disabled={disabled}>
      <div className={styles.row}>
        <label className={styles.field}>{t('projectStructure.propName')}
          <input data-testid={`structure-prop-name-${index}`} value={prop.name} onChange={(event) => updateProp(prop.key, { name: event.target.value })} />
        </label>
        <label className={styles.field}>{t('projectStructure.propType')}
          <select data-testid={`structure-prop-type-${index}`} value={prop.type} onChange={(event) => updateProp(prop.key, { type: event.target.value as PublicPropDraft['type'] })}>
            {['string', 'number', 'boolean', 'enum'].map((type) => <option key={type}>{type}</option>)}
          </select>
        </label>
        <label className={styles.toggle}><input type="checkbox" checked={prop.required} onChange={(event) => updateProp(prop.key, { required: event.target.checked })} />{t('designRuntime.required')}</label>
        <Button aria-label={`${t('common.delete')} ${t('projectStructure.mappingSource')} ${index + 1}`} onClick={() => onChange({ ...value, props: value.props.filter((entry) => entry.key !== prop.key) })}>{t('common.delete')}</Button>
      </div>
      {prop.type === 'enum' ? <div>
        <h5>{t('projectStructure.enumValues')}</h5>
        {prop.values.map((entry, valueIndex) => <div className={styles.row} key={entry.key}>
          <ScalarInput value={entry} testId={`structure-enum-${index}-${valueIndex}`} onChange={(next) => updateProp(prop.key, { values: prop.values.map((candidate) => candidate.key === entry.key ? { ...candidate, ...next } : candidate) })} />
          <Button aria-label={`${t('common.delete')} ${valueIndex + 1}`} onClick={() => updateProp(prop.key, { values: prop.values.filter((candidate) => candidate.key !== entry.key) })}>{t('common.delete')}</Button>
        </div>)}
        <Button onClick={() => updateProp(prop.key, { values: [...prop.values, { key: freshId('value'), kind: 'string', input: '' }] })}>{t('projectStructure.addValue')}</Button>
      </div> : null}
      <label className={styles.toggle}><input data-testid={`structure-prop-default-enabled-${index}`} type="checkbox" checked={prop.hasDefault} onChange={(event) => updateProp(prop.key, { hasDefault: event.target.checked })} />{t('projectStructure.hasDefault')}</label>
      {prop.hasDefault ? <ScalarInput value={prop.defaultValue} testId={`structure-prop-default-${index}`} label={t('projectStructure.defaultValue')} onChange={(defaultValue) => updateProp(prop.key, { defaultValue })} /> : null}
    </fieldset>)}
    <Button disabled={disabled} data-testid="structure-add-prop" onClick={() => onChange({ ...value, props: [...value.props, {
      key: freshId('property'), name: '', type: 'string', required: false, hasDefault: false, defaultValue: { kind: 'string', input: '' }, values: [],
    }] })}>{t('projectStructure.addProp')}</Button>
    <h4>{t('designRuntime.propMappings')}</h4>
    <p className={styles.muted}>{t('projectStructure.mappingHint')}</p>
    {value.mappings.map((mapping, index) => <fieldset key={mapping.key} disabled={disabled} className={styles.row}>
      <label className={styles.field}>{t('projectStructure.mappingSource')}
        <select data-testid={`structure-mapping-source-${index}`} value={mapping.prop} onChange={(event) => onChange({ ...value, mappings: value.mappings.map((entry) => entry.key === mapping.key ? { ...entry, prop: event.target.value } : entry) })}>
          {!value.props.some((prop) => prop.name === mapping.prop) ? <option value={mapping.prop}>{mapping.prop || t('common.none')}</option> : null}
          {value.props.map((prop) => <option key={prop.key} value={prop.name}>{prop.name || t('common.none')}</option>)}
        </select>
      </label>
      <label className={styles.field}>{t('projectStructure.mappingTarget')}
        <select data-testid={`structure-mapping-target-${index}`} value={targetKey(mapping)} onChange={(event) => {
          const target = targets.find((entry) => targetKey(entry) === event.target.value);
          if (target) onChange({ ...value, mappings: value.mappings.map((entry) => entry.key === mapping.key ? { ...entry, nodeId: target.nodeId, path: target.path } : entry) });
        }}>
          {!targets.some((target) => targetKey(target) === targetKey(mapping)) ? <option value={targetKey(mapping)}>{mapping.nodeId ? `${mapping.nodeId} · ${mapping.path.join('.')}` : t('projectStructure.chooseTarget')}</option> : null}
          {targets.map((target) => <option key={targetKey(target)} value={targetKey(target)}>{target.label}</option>)}
        </select>
      </label>
      <Button aria-label={`${t('common.delete')} ${t('designRuntime.propMappings')} ${index + 1}`} onClick={() => onChange({ ...value, mappings: value.mappings.filter((entry) => entry.key !== mapping.key) })}>{t('common.delete')}</Button>
    </fieldset>)}
    <Button disabled={disabled || !value.props.length} data-testid="structure-add-mapping" onClick={() => onChange({ ...value, mappings: [...value.mappings, {
      key: freshId('mapping'), prop: value.props[0]!.name, nodeId: '', path: ['text'],
    }] })}>{t('projectStructure.addMapping')}</Button>
  </section>;
}

function ScalarInput({ value, onChange, testId, label }: { value: ScalarDraft; onChange(value: ScalarDraft): void; testId: string; label?: string }) {
  const t = useT();
  return <div className={styles.row}>
    <label className={styles.field}>{t('designRuntime.valueType')}
      <select data-testid={`${testId}-kind`} value={value.kind} onChange={(event) => onChange({ kind: event.target.value as ScalarDraft['kind'], input: event.target.value === 'boolean' ? 'false' : event.target.value === 'null' ? 'null' : value.input })}>
        {['string', 'number', 'boolean', 'null'].map((kind) => <option key={kind}>{kind}</option>)}
      </select>
    </label>
    <label className={styles.field}>{label ?? t('projectStructure.enumValues')}
      {value.kind === 'boolean' ? <select data-testid={testId} value={value.input} onChange={(event) => onChange({ ...value, input: event.target.value })}>
        <option value="false">false</option><option value="true">true</option>
      </select> : <input data-testid={testId} value={value.input} readOnly={value.kind === 'null'} inputMode={value.kind === 'number' ? 'decimal' : undefined} onChange={(event) => onChange({ ...value, input: event.target.value })} />}
    </label>
  </div>;
}
