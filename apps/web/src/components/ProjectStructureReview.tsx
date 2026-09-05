import type { ReferenceGraphQueryResult, SharedComponentImpact, UIIRDocument, ValidationDiagnostic } from '@open-design/contracts';
import { useT } from '../i18n';
import styles from './ProjectStructurePanel.module.css';

export function StructureDiagnostics({ diagnostics }: { diagnostics: readonly ValidationDiagnostic[] }) {
  const t = useT();
  return diagnostics.length ? <ul className={styles.diagnostics} aria-label={t('designRuntime.diagnostics')}>
    {diagnostics.map((diagnostic, index) => <li key={index}>
      <strong>{diagnostic.code}</strong> {diagnostic.message}
      <code>{[diagnostic.componentRef, diagnostic.nodeId, diagnostic.path?.join(' → ')].filter(Boolean).join(' · ')}</code>
    </li>)}
  </ul> : null;
}

export function ReferenceUsages({ usages, document }: { usages: ReferenceGraphQueryResult; document: UIIRDocument | null }) {
  const t = useT();
  const screenName = (id: string) => document?.screens.find((screen) => screen.id === id)?.name ?? id;
  return <div className={styles.usages}>
    <h5>{t('projectStructure.affectedScreens')} ({usages.affectedScreens.length})</h5>
    <ul>{usages.affectedScreens.map((owner) => <li key={owner.screenId}>{screenName(owner.screenId)} <code>{owner.screenId}</code></li>)}</ul>
    <h5>{t('projectStructure.directUsages')} ({usages.directUsages.length})</h5>
    <ul>{usages.directUsages.map((usage, index) => <li key={index}>
      {usage.owner.kind === 'screen' ? screenName(usage.owner.screenId) : usage.owner.componentRef} · <code>{usage.nodeId}</code>
    </li>)}</ul>
    {usages.chains.length ? <details><summary>{t('projectStructure.dependencyChains')}</summary>
      <ul>{usages.chains.map((chain, index) => <li key={index}>{[usages.target, ...chain.map((usage) => usage.owner.kind === 'screen' ? screenName(usage.owner.screenId) : usage.owner.componentRef)].join(' → ')}</li>)}</ul>
    </details> : null}
    <StructureDiagnostics diagnostics={usages.diagnostics} />
  </div>;
}

export function ComponentImpact({ impact, document }: { impact: SharedComponentImpact; document: UIIRDocument | null }) {
  const t = useT();
  return <section className={styles.card} data-testid="structure-impact">
    <h4>{t('projectStructure.impact')} · {impact.baseRevision} → {impact.proposedRevision}</h4>
    <p className={styles.muted}>{t('projectStructure.impactHint')}</p>
    <ReferenceUsages usages={impact.usages} document={document} />
    <h5>{t('projectStructure.current')} · {t('designRuntime.diagnostics')}</h5>
    <StructureDiagnostics diagnostics={impact.current.diagnostics} />
    {!impact.current.diagnostics.length ? <p className={styles.muted}>{t('common.none')}</p> : null}
    <h5>{t('projectStructure.proposed')} · {t('designRuntime.diagnostics')}</h5>
    <StructureDiagnostics diagnostics={impact.diagnostics} />
    {!impact.diagnostics.length ? <p className={styles.muted}>{t('common.none')}</p> : null}
  </section>;
}
