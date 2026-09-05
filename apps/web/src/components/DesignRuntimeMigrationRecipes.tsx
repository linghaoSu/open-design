import { useEffect, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import type { DesignSystemMigrationPlan, DesignSystemMigrationRecipe, ProjectDesignRuntimeState, ProjectDesignRuntimeVersionSummary, ValidationDiagnostic } from '@open-design/contracts';
import { workspaceAccountScopedCacheKey } from '../collab/workspace-identity';
import { instantiateProjectDesignRuntimeMigrationRecipe, listProjectDesignRuntimeMigrationRecipes, ProjectDesignRuntimeError, type ProjectDesignRuntimeScope } from '../providers/design-runtime';
import { useT } from '../i18n';
import { StructureDiagnostics } from './ProjectStructureReview';
import styles from './DesignRuntimeUpgrades.module.css';
interface Props {
  scope: ProjectDesignRuntimeScope; state: ProjectDesignRuntimeState; target: ProjectDesignRuntimeVersionSummary;
  targetRange: string; disabled: boolean;
  onPlan(plan: DesignSystemMigrationPlan): void;
  onSelectionChange(): void;
  onBusyChange(busy: boolean): void;
}
export function DesignRuntimeMigrationRecipes(props: Props) {
  return <RecipeContent key={JSON.stringify([props.scope.projectId, workspaceAccountScopedCacheKey(props.scope.workspaceContext), props.state.revision, props.target])} {...props} />;
}
function RecipeContent({ scope, state, target, targetRange, disabled, onPlan, onSelectionChange, onBusyChange }: Props) {
  const t = useT();
  const [recipes, setRecipes] = useState<DesignSystemMigrationRecipe[] | null>(null); const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [loaded, setLoaded] = useState(false);
  const [diagnostics, setDiagnostics] = useState<ValidationDiagnostic[]>([]);
  const mounted = useRef(false); const generation = useRef(0); const controller = useRef<AbortController | null>(null); const running = useRef(false);
  const latest = useRef({ state, targetRange, onPlan, onBusyChange }); latest.current = { state, targetRange, onPlan, onBusyChange };
  const active = state.lock.dependencies[0];
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1; controller.current?.abort(); latest.current.onBusyChange(false); }; }, []);
  useEffect(() => { generation.current += 1; controller.current?.abort(); running.current = false; setBusy(false); latest.current.onBusyChange(false); setRecipes(null); setSelected(''); setLoaded(false); }, [state]);
  async function perform(use: boolean) {
    if (running.current || disabled || !active || (use && !selected)) return;
    const token = ++generation.current; const abort = new AbortController(); controller.current = abort;
    const current = () => mounted.current && generation.current === token && latest.current.state === state && latest.current.targetRange === targetRange;
    running.current = true; setBusy(true); latest.current.onBusyChange(true); setError(''); setDiagnostics([]); setLoaded(false);
    try {
      const authority = { ...scope, signal: abort.signal };
      if (use) {
        const result = await instantiateProjectDesignRuntimeMigrationRecipe(authority, { expectedRevision: state.revision, designSystemId: target.id, version: target.version, recipeId: selected, planId: 'reviewed-upgrade', targetRange });
        if (!current()) return;
        const plan = result.plan;
        if (result.revision !== state.revision || plan.from.designSystemId !== active.designSystemId || plan.from.version !== active.version || plan.from.digest !== active.digest || plan.from.source.digest !== active.source.digest || plan.to.designSystemId !== target.id || plan.to.version !== target.version || plan.to.digest !== target.digest || plan.to.source.digest !== target.sourceDigest || plan.targetRange !== targetRange || result.recipeId !== selected) throw new Error(t('designUpgrade.staleCatalog'));
        setDiagnostics(result.diagnostics); setLoaded(true); latest.current.onPlan(plan);
      } else {
        const result = await listProjectDesignRuntimeMigrationRecipes(authority, target.id, target.version);
        if (!current()) return;
        if (result.revision !== state.revision) throw new Error(t('designUpgrade.staleCatalog'));
        setRecipes(result.recipes.filter((recipe) => recipe.from.version === active.version && recipe.from.digest === active.digest)); setSelected('');
      }
    } catch (cause) {
      if (!current()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      if (cause instanceof ProjectDesignRuntimeError) setDiagnostics(cause.diagnostics);
    } finally { if (mounted.current && generation.current === token) { running.current = false; setBusy(false); latest.current.onBusyChange(false); } }
  }
  return <section data-testid="upgrade-recipes">
    <h4>{t('designUpgrade.recipeTitle')}</h4><p className={styles.muted}>{t('designUpgrade.recipeHint')}</p>
    <div className={styles.actions}><Button data-testid="upgrade-recipes-load" disabled={disabled || busy} onClick={() => void perform(false)}>{t('designUpgrade.recipeLoad')}</Button></div>
    {recipes?.length ? <><label className={styles.field}>{t('designUpgrade.recipeChoose')}<select data-testid="upgrade-recipe-select" disabled={disabled || busy} value={selected} onChange={(event) => { setSelected(event.target.value); setLoaded(false); setDiagnostics([]); onSelectionChange(); }}><option value="">{t('designUpgrade.recipeChoose')}</option>{recipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.name} · {recipe.id}</option>)}</select></label>
      <Button data-testid="upgrade-recipe-use" disabled={disabled || busy || !selected} onClick={() => void perform(true)}>{t('designUpgrade.recipeUse')}</Button></> : recipes ? <p>{t('designUpgrade.recipeEmpty')}</p> : null}
    {busy ? <p role="status">{t('common.loading')}</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {loaded ? <p role="status">{t('designUpgrade.recipeLoaded')}</p> : null}
    <StructureDiagnostics diagnostics={diagnostics} />
  </section>;
}
