import { useEffect, useId, useState, type ReactNode } from 'react';
import { Button } from '@open-design/components';
import { ComponentPropDefinitionSchema } from '@open-design/contracts';
import type {
  ComponentDefinition,
  ComponentPropDefinition,
  ComponentRegistry,
  JsonValue,
  ProjectComponentDefinition,
  ProjectComponentPropMapping,
  UIIRNode,
  UIIRScreen,
} from '@open-design/contracts';
import { useT } from '../i18n';
import styles from './SemanticTreeEditor.module.css';

interface Catalog {
  registry: ComponentRegistry | null;
  localComponents: readonly ProjectComponentDefinition[];
}

interface EditorActions {
  disabled?: boolean;
  /** Public template mappings are read-only at their target; inherited values stay absent. */
  mappedTargets?: readonly ProjectComponentPropMapping[];
  onExtractComponent?(node: UIIRNode): void;
  onCreateLocalComponent?(): void;
}

export interface SemanticTreeEditorProps extends Catalog, EditorActions {
  nodes: readonly UIIRNode[];
  maxRoots?: number;
  onChange(nodes: UIIRNode[]): void;
}

export interface SemanticScreenEditorProps extends Catalog, EditorActions {
  screen: UIIRScreen;
  onChange(screen: UIIRScreen): void;
}

export interface SemanticTemplateEditorProps extends Catalog, EditorActions {
  template: UIIRNode;
  onChange(template: UIIRNode): void;
}

type NodeChoice = { type: 'text' } | { type: 'component' | 'instance'; ref: string };

function choices(catalog: Catalog, accepts?: readonly string[]): NodeChoice[] {
  const { registry } = catalog;
  const allowed = (ref: string) => accepts === undefined || accepts.includes(ref);
  return [
    ...(allowed('text') ? [{ type: 'text' as const }] : []),
    ...(registry?.components ?? []).flatMap((component) => {
      const ref = `ds:${registry!.id}/${component.id}`;
      return allowed(ref) ? [{ type: 'component' as const, ref }, { type: 'instance' as const, ref }] : [];
    }),
    ...catalog.localComponents.flatMap((component) => {
      const ref = `local:${component.id}`;
      return allowed(ref) || allowedRoot(ref, catalog, accepts) ? [{ type: 'instance' as const, ref }] : [];
    }),
  ];
}

/** New local choices use the template root kind; the daemon validates the full graph. */
function resolvedRootTarget(ref: string, catalog: Catalog, seen = new Set<string>()): string | null {
  if (seen.has(ref)) return null;
  seen.add(ref);
  if (ref.startsWith('ds:')) return catalog.registry?.components.some((component) => ref === `ds:${catalog.registry!.id}/${component.id}`) ? ref : null;
  const definition = catalog.localComponents.find((component) => ref === `local:${component.id}`);
  if (!definition) return null;
  const root = definition.template;
  if (root.type === 'text') return 'text';
  if (root.type === 'component' && root.ref.startsWith('local:')) return null;
  return resolvedRootTarget(root.ref, catalog, seen);
}

function allowedRoot(ref: string, catalog: Catalog, accepts?: readonly string[]): boolean {
  const root = resolvedRootTarget(ref, catalog);
  return root !== null && (accepts === undefined || accepts.includes(root));
}

function definitionFor(ref: string, catalog: Catalog): ComponentDefinition | ProjectComponentDefinition | undefined {
  return catalog.registry?.components.find((component) => ref === `ds:${catalog.registry!.id}/${component.id}`)
    ?? catalog.localComponents.find((component) => ref === `local:${component.id}`);
}

function createNode(choice: NodeChoice): UIIRNode {
  const id = `node-${crypto.randomUUID()}`;
  return choice.type === 'text' ? { schemaVersion: 1, type: 'text', id, text: '' }
    : choice.type === 'instance' ? { schemaVersion: 1, type: 'instance', id, ref: choice.ref, overrides: [] }
      : { schemaVersion: 1, type: 'component', id, ref: choice.ref };
}

function defaultValue(definition: ComponentPropDefinition): JsonValue {
  if (definition.default !== undefined) return definition.default;
  if (definition.type === 'enum') return definition.values[0]!;
  return definition.type === 'boolean' ? false : definition.type === 'number' ? 0 : '';
}

/** Only the explicitly edited field changes; all existing node identities survive. */
function setProp(node: Exclude<UIIRNode, { type: 'text' }>, name: string, value: JsonValue | undefined): UIIRNode {
  if (node.type === 'instance') {
    const overrides = node.overrides.filter((override) => override.path[1] !== name);
    if (value !== undefined) overrides.push({ schemaVersion: 1, path: ['props', name], value });
    return { ...node, overrides };
  }
  const props = { ...node.props };
  if (value === undefined) delete props[name];
  else props[name] = value;
  if (Object.keys(props).length) return { ...node, props };
  const { props: _props, ...withoutProps } = node;
  return withoutProps;
}

export function SemanticTreeEditor({ nodes, maxRoots, onChange, ...context }: SemanticTreeEditorProps) {
  const t = useT();
  return <section className={styles.editor} aria-label={t('semanticEditor.title')}>
    {context.onCreateLocalComponent ? <Button disabled={context.disabled} onClick={context.onCreateLocalComponent}>{t('semanticEditor.newComponent')}</Button> : null}
    <NodeList {...context} nodes={nodes} onChange={onChange} scopeId="root" maxNodes={maxRoots} minNodes={maxRoots === 1 ? 1 : 0} />
  </section>;
}

export function SemanticScreenEditor({ screen, onChange, ...context }: SemanticScreenEditorProps) {
  const t = useT();
  return <section className={styles.editor} aria-label={t('semanticEditor.screen')}>
    <label className={styles.field}>{t('semanticEditor.screenName')}
      <input disabled={context.disabled} value={screen.name ?? ''} onChange={(event) => {
        const { name: _name, ...withoutName } = screen;
        onChange(event.target.value ? { ...screen, name: event.target.value } : withoutName);
      }} />
    </label>
    <SemanticTreeEditor {...context} nodes={screen.children} onChange={(children) => onChange({ ...screen, children })} />
  </section>;
}

export function SemanticTemplateEditor({ template, onChange, ...context }: SemanticTemplateEditorProps) {
  const t = useT();
  return <section aria-label={t('semanticEditor.template')}>
    <SemanticTreeEditor {...context} nodes={[template]} maxRoots={1} onChange={(nodes) => {
      if (nodes.length === 1) onChange(nodes[0]!);
    }} />
  </section>;
}

interface NodeListProps extends Catalog, EditorActions {
  nodes: readonly UIIRNode[];
  scopeId: string;
  accepts?: readonly string[];
  maxNodes?: number;
  minNodes?: number;
  onChange(nodes: UIIRNode[]): void;
}

function NodeList({ nodes, scopeId, accepts, maxNodes, minNodes = 0, onChange, ...context }: NodeListProps) {
  const t = useT();
  function move(index: number, offset: number) {
    const next = [...nodes];
    const target = index + offset;
    if (target < 0 || target >= nodes.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  }
  return <div className={styles.nodeList}>
    {maxNodes !== undefined && nodes.length > maxNodes ? <p className={styles.error} role="alert">{t('semanticEditor.maxNodes', { count: maxNodes })}</p> : null}
    <ol className={styles.nodes}>
      {nodes.map((node, index) => <li key={node.id} data-testid={`semantic-node-${node.id}`}>
        {accepts !== undefined && !(node.type === 'text' ? accepts.includes('text')
          : accepts.includes(node.ref) || (node.type === 'instance' && allowedRoot(node.ref, context, accepts)))
          ? <p className={styles.error} role="alert">{t('semanticEditor.invalidChild')}</p> : null}
        <NodeEditor {...context} node={node} onChange={(next) => onChange(nodes.map((previous, position) => position === index ? next : previous))}>
          <Button disabled={context.disabled || index === 0} aria-label={`${t('semanticEditor.moveUp')} ${node.id}`} onClick={() => move(index, -1)}>{t('semanticEditor.moveUp')}</Button>
          <Button disabled={context.disabled || index === nodes.length - 1} aria-label={`${t('semanticEditor.moveDown')} ${node.id}`} onClick={() => move(index, 1)}>{t('semanticEditor.moveDown')}</Button>
          <Button variant="ghost" disabled={context.disabled || nodes.length <= minNodes} aria-label={`${t('common.delete')} ${node.id}`} onClick={() => onChange(nodes.filter((_, position) => position !== index))}>{t('common.delete')}</Button>
        </NodeEditor>
      </li>)}
    </ol>
    <AddNode {...context} accepts={accepts} scopeId={scopeId} full={maxNodes !== undefined && nodes.length >= maxNodes} onAdd={(node) => onChange([...nodes, node])} />
  </div>;
}

function AddNode({ accepts, scopeId, full, onAdd, ...context }: Catalog & EditorActions & {
  accepts?: readonly string[];
  scopeId: string;
  full: boolean;
  onAdd(node: UIIRNode): void;
}) {
  const t = useT();
  const id = useId();
  const [selected, setSelected] = useState('');
  const available = choices(context, accepts);
  const encoded = available.map((choice) => JSON.stringify(choice));
  const effective = encoded.includes(selected) ? selected : encoded[0] ?? '';
  return <div className={styles.add}>
    <label htmlFor={id}>{t('semanticEditor.addNode')}</label>
    <select id={id} data-testid={`semantic-add-choice-${scopeId}`} disabled={context.disabled || full || !available.length} value={effective} onChange={(event) => setSelected(event.target.value)}>
      {!available.length ? <option value="">{t('semanticEditor.noChoices')}</option> : null}
      {available.map((choice, index) => <option key={encoded[index]} value={encoded[index]}>
        {t(`semanticEditor.${choice.type}`)}{choice.type === 'text' ? '' : `: ${definitionFor(choice.ref, context)?.name ?? choice.ref}`}
      </option>)}
    </select>
    <Button data-testid={`semantic-add-node-${scopeId}`} disabled={context.disabled || full || !available.length} onClick={() => {
      const choice = available[encoded.indexOf(effective)];
      if (choice) onAdd(createNode(choice));
    }}>{t('semanticEditor.addNode')}</Button>
  </div>;
}

function NodeEditor({ node, onChange, children, ...context }: Catalog & EditorActions & {
  node: UIIRNode;
  children: ReactNode;
  onChange(node: UIIRNode): void;
}) {
  const t = useT();
  const definition = node.type === 'text' ? undefined : definitionFor(node.ref, context);
  const referenceChoices = node.type === 'text' ? [] : choices(context).filter((choice): choice is Exclude<NodeChoice, { type: 'text' }> => choice.type === node.type);
  const referenceKnown = node.type === 'text' || referenceChoices.some((choice) => choice.ref === node.ref);
  const values: Record<string, JsonValue> = node.type === 'text' ? {} : node.type === 'instance'
    ? Object.fromEntries(node.overrides.map((override) => [override.path[1], override.value])) : node.props ?? {};
  const props = definition?.props ?? {};
  const slots = definition && 'slots' in definition ? definition.slots ?? {} : {};
  const slotNames = node.type === 'component' ? [...new Set([...Object.keys(slots), ...Object.keys(node.slots ?? {})])] : [];
  const textMapping = context.mappedTargets?.find((mapping) => mapping.nodeId === node.id && mapping.path[0] === 'text');
  return <article className={styles.node}>
    <header className={styles.header}>
      <div><strong>{t(`semanticEditor.${node.type}`)}{definition ? ` · ${definition.name}` : ''}</strong><code className={styles.identity}>{node.id}</code></div>
      <div className={styles.actions}>
        {context.onExtractComponent ? <Button disabled={context.disabled} onClick={() => context.onExtractComponent?.(node)}>{t('semanticEditor.extract')}</Button> : null}
        {children}
      </div>
    </header>
    {node.type === 'text' ? <>
      <label className={styles.field}>{t('semanticEditor.text')}
        <textarea data-testid={`semantic-text-${node.id}`} disabled={context.disabled || !!textMapping} value={node.text} rows={2} onChange={(event) => onChange({ ...node, text: event.target.value })} />
      </label>
      {textMapping ? <p className={styles.muted}>{t('semanticEditor.drivenBy', { name: textMapping.prop })}</p> : null}
      {textMapping && node.text !== '' ? <div className={styles.unknown}>
        <p className={styles.error}>{t('semanticEditor.mappedConflict')}</p>
        <Button disabled={context.disabled} onClick={() => onChange({ ...node, text: '' })}>{t('common.delete')}</Button>
      </div> : null}
    </> : <>
      <label className={styles.field}>{t('semanticEditor.reference')}
        <select data-testid={`semantic-reference-${node.id}`} disabled={context.disabled} value={node.ref} onChange={(event) => onChange({ ...node, ref: event.target.value })}>
          {!referenceKnown ? <option value={node.ref}>{node.ref}</option> : null}
          {referenceChoices.map((choice) => <option key={choice.ref} value={choice.ref}>{definitionFor(choice.ref, context)?.name} · {choice.ref}</option>)}
        </select>
      </label>
      {!referenceKnown ? <p className={styles.error} role="alert">{t('semanticEditor.missingReference', { ref: node.ref })}</p> : null}
      <div className={styles.props}>
        {Object.entries(props).map(([name, prop]) => <ScalarPropEditor
          key={name} nodeId={node.id} name={name} definition={prop} value={values[name]}
          explicit={Object.hasOwn(values, name)} instance={node.type === 'instance'} disabled={context.disabled}
          mappedBy={context.mappedTargets?.find((mapping) => mapping.nodeId === node.id && mapping.path[0] === 'props' && mapping.path[1] === name)?.prop}
          onChange={(value) => onChange(setProp(node, name, value))}
        />)}
        {Object.keys(values).filter((name) => !Object.hasOwn(props, name)).map((name) => <div key={name} className={styles.unknown}>
          <span>{t('semanticEditor.unknownProp', { name })}: <code>{JSON.stringify(values[name])}</code></span>
          <Button disabled={context.disabled} aria-label={`${t('common.delete')} ${name}`} onClick={() => onChange(setProp(node, name, undefined))}>{t('common.delete')}</Button>
        </div>)}
      </div>
      {node.type === 'component' ? slotNames.map((name) => {
        const slot = Object.hasOwn(slots, name) ? slots[name] : undefined;
        return <section key={name} className={styles.slot} aria-label={`${t('designRuntime.slots')}: ${name}`}>
          <h4>{name} {slot ? <span className={styles.muted}>· {slot.required ? t('designRuntime.required') : t('designRuntime.optional')}</span> : null}</h4>
          {!slot ? <p className={styles.error}>{t('semanticEditor.unknownSlot', { name })}</p> : null}
          <NodeList {...context} nodes={node.slots && Object.hasOwn(node.slots, name) ? node.slots[name]! : []} scopeId={`${node.id}-${name}`} accepts={slot?.accepts ?? []} maxNodes={slot?.multiple ? undefined : slot ? 1 : undefined} onChange={(next) => {
            const nextSlots = { ...node.slots };
            if (next.length) nextSlots[name] = next;
            else delete nextSlots[name];
            if (Object.keys(nextSlots).length) onChange({ ...node, slots: nextSlots });
            else {
              const { slots: _slots, ...withoutSlots } = node;
              onChange(withoutSlots);
            }
          }} />
        </section>;
      }) : null}
    </>}
  </article>;
}

function ScalarPropEditor({ nodeId, name, definition, value, explicit, instance, disabled, mappedBy, onChange }: {
  nodeId: string;
  name: string;
  definition: ComponentPropDefinition;
  value: JsonValue | undefined;
  explicit: boolean;
  instance: boolean;
  disabled?: boolean;
  mappedBy?: string;
  onChange(value: JsonValue | undefined): void;
}) {
  const t = useT();
  const effective = explicit && value !== undefined ? value : defaultValue(definition);
  const [numberText, setNumberText] = useState(String(effective));
  const [numberInvalid, setNumberInvalid] = useState(definition.type === 'number' && typeof effective !== 'number');
  useEffect(() => {
    setNumberText(String(effective));
    setNumberInvalid(definition.type === 'number' && (typeof effective !== 'number' || !Number.isFinite(effective)));
  }, [effective, definition.type]);
  const inherited = !explicit;
  const invalidValue = explicit && !ComponentPropDefinitionSchema.safeParse({ ...definition, default: value }).success;
  if (mappedBy && inherited) return <div className={styles.prop}>
    <strong>{name}</strong><p className={styles.muted}>{t('semanticEditor.drivenBy', { name: mappedBy })}</p>
  </div>;
  const fieldDisabled = disabled || inherited || !!mappedBy;
  return <div className={styles.prop}>
    <div className={styles.propHeader}>
      <label className={styles.toggle}>
        <input data-testid={`semantic-explicit-${nodeId}-${name}`} type="checkbox" disabled={disabled || !!mappedBy} checked={explicit} onChange={(event) => onChange(event.target.checked ? defaultValue(definition) : undefined)} />
        {instance ? t('semanticEditor.override', { name }) : name}
      </label>
      <Button variant="ghost" data-testid={`semantic-reset-${nodeId}-${name}`} disabled={disabled || inherited || !!mappedBy} onClick={() => onChange(undefined)}>{t('semanticEditor.reset')}</Button>
    </div>
    <label className={styles.field}>{name}
      {definition.type === 'enum' ? <select data-testid={`semantic-prop-${nodeId}-${name}`} disabled={fieldDisabled} value={definition.values.findIndex((candidate) => candidate === effective)} onChange={(event) => onChange(definition.values[Number(event.target.value)]!)}>
        {!definition.values.some((candidate) => candidate === effective) ? <option value={-1}>{JSON.stringify(effective)}</option> : null}
        {definition.values.map((candidate, index) => <option key={index} value={index}>{JSON.stringify(candidate)}</option>)}
      </select> : definition.type === 'boolean' ? <select data-testid={`semantic-prop-${nodeId}-${name}`} disabled={fieldDisabled} value={typeof effective === 'boolean' ? String(effective) : 'invalid'} onChange={(event) => onChange(event.target.value === 'true')}>
        {typeof effective !== 'boolean' ? <option value="invalid">{JSON.stringify(effective)}</option> : null}
        <option value="false">false</option><option value="true">true</option>
      </select> : definition.type === 'number' ? <input data-testid={`semantic-prop-${nodeId}-${name}`} disabled={fieldDisabled} inputMode="decimal" value={numberText} aria-invalid={numberInvalid} onChange={(event) => {
        const text = event.target.value;
        setNumberText(text);
        const valid = text.trim() !== '' && Number.isFinite(Number(text));
        setNumberInvalid(!valid);
        onChange(valid ? Number(text) : text);
      }} /> : <input data-testid={`semantic-prop-${nodeId}-${name}`} disabled={fieldDisabled} value={typeof effective === 'string' ? effective : JSON.stringify(effective)} onChange={(event) => onChange(event.target.value)} />}
    </label>
    {mappedBy ? <div className={styles.unknown}>
      <p className={styles.error}>{t('semanticEditor.mappedConflict')} {t('semanticEditor.drivenBy', { name: mappedBy })}</p>
      <Button disabled={disabled} aria-label={`${t('common.delete')} ${name}`} onClick={() => onChange(undefined)}>{t('common.delete')}</Button>
    </div> : null}
    {numberInvalid ? <p className={styles.error} role="alert">{t('semanticEditor.invalidNumber')}</p> : null}
    {invalidValue && !numberInvalid ? <p className={styles.error} role="alert">{t('semanticEditor.invalidValue')}</p> : null}
    {inherited ? <p className={styles.muted}>{definition.default !== undefined ? `${t('semanticEditor.inherited')}: ${JSON.stringify(definition.default)}` : t('semanticEditor.unset')}</p> : null}
    <span className={styles.muted}>{definition.required ? t('designRuntime.required') : t('designRuntime.optional')}</span>
  </div>;
}
