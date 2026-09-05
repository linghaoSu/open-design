import {
  DesignSystemDiffResultSchema,
  DesignSystemVersionSchema,
  type ComponentPropDefinition,
  type ComponentSlotDefinition,
  type ComponentStoryDefinition,
  type DesignSystemDiffEntity,
  type DesignSystemDiffResult,
  type DesignSystemDiffValue,
  type DesignSystemLockedDependency,
  type DesignSystemSemanticChange,
  type DesignSystemVersion,
  type ValidationDiagnostic,
} from '@open-design/contracts';
import { acceptsComponentPropertyDomain } from './component-validator.js';
import { canonicalDesignSystemJson, verifyDesignSystemVersion } from './design-system-version.js';
import { compareDesignRuntimeKeys } from './reference-graph.js';

const same = (left: unknown, right: unknown): boolean => canonicalDesignSystemJson(left) === canonicalDesignSystemJson(right);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const own = (value: unknown, key: string): unknown => { const record = object(value); return Object.hasOwn(record, key) ? record[key] : undefined; };
const keys = (left: object, right: object): string[] => [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(compareDesignRuntimeKeys);
const setValues = (value: unknown): string[] => [...new Set((Array.isArray(value) ? value : []).map(canonicalDesignSystemJson))].sort(compareDesignRuntimeKeys);
const sameSet = (left: unknown, right: unknown): boolean => same(setValues(left), setValues(right));
const containsSet = (larger: unknown, smaller: unknown): boolean => { const values = new Set(setValues(larger)); return setValues(smaller).every((value) => values.has(value)); };

function snapshot(value: unknown): DesignSystemDiffValue {
  return value === undefined ? { present: false } : { present: true, value: JSON.parse(canonicalDesignSystemJson(value)) };
}
function endpoint(version: DesignSystemVersion): DesignSystemLockedDependency {
  return { designSystemId: version.package.id, version: version.package.version, digest: version.digest, source: { type: 'bundle', digest: version.sourceDigest } };
}

/** Computes semantic facts from verified frozen versions. No filesystem, clocks, or guessed rename matching. */
export function diffDesignSystemVersions(from: DesignSystemVersion, to: DesignSystemVersion): DesignSystemDiffResult {
  const diagnostics: ValidationDiagnostic[] = [];
  for (const [side, version] of [['from', from], ['to', to]] as const) {
    for (const diagnostic of verifyDesignSystemVersion(version)) diagnostics.push({ ...diagnostic, path: [side, ...(diagnostic.path ?? [])] });
  }
  const fail = (): DesignSystemDiffResult => DesignSystemDiffResultSchema.parse({ schemaVersion: 1, ok: false, diff: null, diagnostics });
  if (diagnostics.length) return fail();
  const before = DesignSystemVersionSchema.parse(from); const after = DesignSystemVersionSchema.parse(to);
  if (before.package.id !== after.package.id) diagnostics.push({ schemaVersion: 1, code: 'ODDS5001', severity: 'error', message: 'Semantic diff requires the same design-system identity.', path: ['to', 'package', 'id'] });
  if (before.package.id === after.package.id && before.package.version === after.package.version && (before.digest !== after.digest || before.sourceDigest !== after.sourceDigest)) {
    diagnostics.push({ schemaVersion: 1, code: 'ODDS5006', severity: 'error', message: 'An exact published version cannot contain divergent snapshots.', path: ['to'] });
  }
  if (diagnostics.length) return fail();

  const changes: DesignSystemSemanticChange[] = [];
  let additive = false;
  function emit(entity: DesignSystemDiffEntity, path: string[], oldValue: unknown, newValue: unknown, breaking: boolean, reason: string, minor = false, renamed = false): void {
    if (same(oldValue, newValue)) return;
    const kind = oldValue === undefined ? 'added' : newValue === undefined ? 'removed' : renamed ? 'renamed' : 'changed';
    changes.push({ schemaVersion: 1, id: `change${Buffer.from(canonicalDesignSystemJson([entity, path, kind]), 'utf8').toString('hex')}`, entity, path, kind, breaking, reason, before: snapshot(oldValue), after: snapshot(newValue) });
    additive ||= minor && !breaking;
  }
  function properties(entity: DesignSystemDiffEntity, oldValue: unknown, newValue: unknown): void {
    const oldProps = object(oldValue); const newProps = object(newValue);
    for (const name of keys(oldProps, newProps)) {
      const oldProp = own(oldProps, name) as ComponentPropDefinition | undefined; const newProp = own(newProps, name) as ComponentPropDefinition | undefined;
      const path = ['props', name];
      if (!oldProp || !newProp) {
        const breaking = !newProp || (newProp.required && newProp.default === undefined);
        emit(entity, path, oldProp, newProp, breaking, !newProp ? 'Public property removed.' : breaking ? 'Required property added without a default.' : 'Compatible public property added.', !breaking);
        continue;
      }
      // The inheritance helper accounts for materialized defaults. Public callers can
      // omit a required prop with a default, so omission is compared separately here.
      const oldOmittable = !oldProp.required || oldProp.default !== undefined;
      const newOmittable = !newProp.required || newProp.default !== undefined;
      const contains = acceptsComponentPropertyDomain({ ...oldProp, required: true }, { ...newProp, required: true });
      if (oldProp.type !== newProp.type) {
        const breaking = !contains || (oldOmittable && !newOmittable);
        emit(entity, path, oldProp, newProp, breaking, breaking ? 'Property type no longer accepts every previously valid caller.' : 'Property type widened compatibly.', !breaking);
        continue;
      }
      for (const field of keys(oldProp, newProp)) {
        if (field === 'type') continue;
        const oldField = own(oldProp, field); const newField = own(newProp, field);
        if (field === 'values') {
          if (!sameSet(oldField, newField)) emit(entity, [...path, field], oldField, newField, !contains, contains ? 'Allowed property values widened.' : 'Previously allowed property values removed.', contains);
        } else if (field === 'required' || field === 'default') {
          const breaking = oldOmittable && !newOmittable;
          emit(entity, [...path, field], oldField, newField, breaking, breaking ? 'Property omission is no longer accepted.' : field === 'default' ? 'Inherited default value changed.' : 'Property requiredness changed compatibly.', !oldOmittable && newOmittable);
        } else emit(entity, [...path, field], oldField, newField, field !== 'source', field === 'source' ? 'Property source provenance changed.' : 'Unrecognized property metadata changed; compatibility requires review.');
      }
    }
  }
  function slots(entity: DesignSystemDiffEntity, oldValue: unknown, newValue: unknown): void {
    const oldSlots = object(oldValue); const newSlots = object(newValue);
    for (const name of keys(oldSlots, newSlots)) {
      const oldSlot = own(oldSlots, name) as ComponentSlotDefinition | undefined; const newSlot = own(newSlots, name) as ComponentSlotDefinition | undefined;
      const path = ['slots', name];
      if (!oldSlot || !newSlot) {
        const breaking = !newSlot || newSlot.required;
        emit(entity, path, oldSlot, newSlot, breaking, !newSlot ? 'Public slot removed.' : breaking ? 'Required slot added.' : 'Optional slot added.', !breaking);
        continue;
      }
      for (const field of keys(oldSlot, newSlot)) {
        const oldField = own(oldSlot, field); const newField = own(newSlot, field);
        if (field === 'accepts') {
          if (!sameSet(oldField, newField)) {
            const breaking = !containsSet(newField, oldField);
            emit(entity, [...path, field], oldField, newField, breaking, breaking ? 'Slot accepted content narrowed.' : 'Slot accepted content widened.', !breaking);
          }
        } else if (field === 'source') {
          emit(entity, [...path, field], oldField, newField, false, 'Slot source provenance changed.');
        } else {
          const breaking = field === 'required' ? newField === true : field === 'multiple' ? newField === false : true;
          emit(entity, [...path, field], oldField, newField, breaking, field === 'required' ? 'Slot requiredness changed.' : field === 'multiple' ? 'Slot cardinality changed.' : 'Unrecognized slot metadata changed; compatibility requires review.', !breaking);
        }
      }
    }
  }
  function fields(entity: DesignSystemDiffEntity, oldValue: unknown, newValue: unknown): void {
    const oldFields = object(oldValue); const newFields = object(newValue);
    for (const field of keys(oldFields, newFields)) {
      if (field === 'id' || field === 'schemaVersion') continue;
      const a = own(oldFields, field); const b = own(newFields, field);
      if (entity.kind === 'component' && field === 'stories') {
        // Stories are named presets/annotations, never production prop defaults.
        const stories = (value: unknown) => new Map((Array.isArray(value) ? value as ComponentStoryDefinition[] : []).map((story) => [story.id, story]));
        const oldStories = stories(a); const newStories = stories(b);
        for (const id of [...new Set([...oldStories.keys(), ...newStories.keys()])].sort(compareDesignRuntimeKeys)) {
          const previous = oldStories.get(id); const current = newStories.get(id);
          emit(entity, ['stories', id], previous, current, false, !previous ? 'Story preset added; production defaults are unchanged.' : !current ? 'Story preset removed; production defaults are unchanged.' : 'Story preset or annotations changed; production defaults are unchanged.', !previous);
        }
        continue;
      }
      if ((field === 'propMappings' || field === 'slotMappings') && sameSet(a, b)) continue;
      if (entity.kind === 'binding' && field === 'slotMappings') {
        const facts = (value: unknown) => (Array.isArray(value) ? value : []).map((mapping) => {
          const { source: _source, ...contract } = object(mapping); return contract;
        });
        if (sameSet(facts(a), facts(b))) { emit(entity, [field], a, b, false, 'Slot mapping source provenance changed.'); continue; }
      }
      if (field === 'name') { emit(entity, [field], a, b, false, 'Display name changed; stable identity is preserved.', false, true); continue; }
      if (field === 'props') { properties(entity, a, b); continue; }
      if (field === 'slots') { slots(entity, a, b); continue; }
      if (field === 'states') {
        if (!sameSet(a, b)) { const breaking = !containsSet(b, a); emit(entity, [field], a, b, breaking, breaking ? 'Declared component states removed.' : 'Declared component states added.', !breaking); }
        continue;
      }
      const visual = field === 'source' || (entity.kind === 'token' && ['value', 'unit'].includes(field))
        || (entity.kind === 'pattern' && ['template', 'description', 'propMappings', 'slotMappings'].includes(field));
      if (visual) { emit(entity, [field], a, b, false, field === 'source' ? 'Source provenance changed; public import compatibility is reported separately.' : 'Visual or inherited content changed.'); continue; }
      // Restoring a verified binding is additive; losing one or remapping production
      // props is conservative because this changes the code-generation contract.
      const restoredBinding = entity.kind === 'binding' && ((field === 'status' && b === 'bound') || (field === 'verified' && b === true));
      emit(entity, [field], a, b, !restoredBinding, entity.kind === 'token' && field === 'cssVariable' ? 'Public CSS variable renamed; existing CSS consumers require migration.'
        : entity.kind === 'code-component' ? 'Public code import or export contract changed.'
          : entity.kind === 'binding' ? 'Production component binding contract changed.' : 'Metadata contract changed; compatibility requires review.', restoredBinding);
    }
  }
  function entities(kind: 'component' | 'token' | 'pattern' | 'code-component' | 'binding', oldValues: readonly { id: string }[], newValues: readonly { id: string }[]): void {
    const oldEntities = new Map(oldValues.map((value) => [value.id, value])); const newEntities = new Map(newValues.map((value) => [value.id, value]));
    for (const id of [...new Set([...oldEntities.keys(), ...newEntities.keys()])].sort(compareDesignRuntimeKeys)) {
      const a = oldEntities.get(id); const b = newEntities.get(id); const entity = { kind, id } as DesignSystemDiffEntity;
      if (!a || !b) emit(entity, [], a, b, !b, b ? 'Stable entity added.' : 'Stable entity removed; existing references require migration.', Boolean(b));
      else fields(entity, a, b);
    }
  }
  const a = before.package; const b = after.package;
  entities('component', a.registry.components, b.registry.components);
  entities('token', a.tokens.tokens, b.tokens.tokens);
  entities('pattern', a.patterns.patterns, b.patterns.patterns);
  entities('code-component', a.codeIndex.components, b.codeIndex.components);
  entities('binding', a.bindings.bindings, b.bindings.bindings);
  const oldRecipes = new Map((a.migrations ?? []).map((recipe) => [recipe.id, recipe]));
  const newRecipes = new Map((b.migrations ?? []).map((recipe) => [recipe.id, recipe]));
  for (const id of [...new Set([...oldRecipes.keys(), ...newRecipes.keys()])].sort(compareDesignRuntimeKeys)) {
    emit({ kind: 'migration', id }, [], oldRecipes.get(id), newRecipes.get(id), false, 'Authored migration recipe changed; selecting it requires a separate impact review.');
  }
  emit({ kind: 'design-system', id: a.id }, ['name'], a.name, b.name, false, 'Display name changed; stable identity is preserved.', false, true);
  emit({ kind: 'design-system', id: a.id }, ['origin'], a.origin, b.origin, false, 'Package source provenance changed.');

  for (const mode of ['explore', 'guided', 'strict'] as const) {
    const visit = (left: unknown, right: unknown, path: string[]): void => {
      if (left !== null && typeof left === 'object' && right !== null && typeof right === 'object') {
        for (const field of keys(object(left), object(right))) visit(own(left, field), own(right, field), [...path, field]);
      } else {
        const ranks = new Map([['off', 0], ['warning', 1], ['error', 2]]);
        const breaking = (ranks.get(String(right)) ?? Infinity) > (ranks.get(String(left)) ?? -Infinity);
        emit({ kind: 'constraint', mode }, path, left, right, breaking, breaking ? 'Constraint severity tightened.' : 'Constraint severity relaxed.', !breaking);
      }
    };
    visit(a.constraints[mode], b.constraints[mode], []);
  }
  const compatibilityKey = (value: { framework: string; packageName: string }) => canonicalDesignSystemJson([value.framework, value.packageName]);
  const oldCompatibility = new Map(a.codeCompatibility.map((value) => [compatibilityKey(value), value])); const newCompatibility = new Map(b.codeCompatibility.map((value) => [compatibilityKey(value), value]));
  for (const key of [...new Set([...oldCompatibility.keys(), ...newCompatibility.keys()])].sort(compareDesignRuntimeKeys)) {
    const oldEntry = oldCompatibility.get(key); const newEntry = newCompatibility.get(key); const identity = oldEntry ?? newEntry!;
    emit({ kind: 'code-compatibility', framework: identity.framework, packageName: identity.packageName }, [], oldEntry, newEntry, Boolean(oldEntry), oldEntry ? 'Declared production package compatibility changed; review consumers.' : 'Production package compatibility added.', !oldEntry);
  }
  const oldFiles = new Map(a.source.files.map((file) => [file.path, file])); const newFiles = new Map(b.source.files.map((file) => [file.path, file]));
  for (const path of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort(compareDesignRuntimeKeys)) {
    const oldFile = oldFiles.get(path); const newFile = newFiles.get(path);
    emit({ kind: 'source', path }, [], oldFile, newFile, false, !newFile ? 'Frozen source file removed; public import changes are reported separately.' : !oldFile ? 'Frozen source file added.' : 'Frozen source content or encoding changed; public import changes are reported separately.');
  }
  changes.sort((left, right) => compareDesignRuntimeKeys(canonicalDesignSystemJson([left.entity, left.path, left.kind]), canonicalDesignSystemJson([right.entity, right.path, right.kind])));
  return DesignSystemDiffResultSchema.parse({ schemaVersion: 1, ok: true, diagnostics: [], diff: {
    schemaVersion: 1, from: endpoint(before), to: endpoint(after), changes,
    recommendedBump: changes.some((change) => change.breaking) ? 'major' : additive ? 'minor' : changes.length ? 'patch' : 'none',
  } });
}
