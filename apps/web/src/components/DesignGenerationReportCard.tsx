import type { ChatMessage } from '@open-design/contracts';
import { useT } from '../i18n';
import { applicableDesignGenerationReport } from '../runtime/design-generation';
import styles from './DesignGenerationReportCard.module.css';

export function DesignGenerationReportCard({ message }: { message: ChatMessage }) {
  const t = useT();
  const task = message.designGenerationTask;
  const report = applicableDesignGenerationReport(message);
  if (!report) return null;
  const seenDiagnostics = new Set<string>();
  const diagnostics = [...report.diagnostics, ...(report.validation?.diagnostics ?? [])].filter(diagnostic => {
    const identity = JSON.stringify([diagnostic.code, diagnostic.severity, diagnostic.message, diagnostic.nodeId,
      diagnostic.componentRef, diagnostic.path, diagnostic.location?.sourcePath, diagnostic.location?.line, diagnostic.location?.column]);
    if (seenDiagnostics.has(identity)) return false;
    seenDiagnostics.add(identity);
    return true;
  });
  // Put actionable blockers first without changing the recorded report or hiding evidence.
  const rankedDiagnostics = [...diagnostics].sort((left, right) => Number(right.severity === 'error') - Number(left.severity === 'error'));
  const renderDiagnostic = (diagnostic: typeof diagnostics[number], index: number) => <li key={index} data-severity={diagnostic.severity}>
    <code>{diagnostic.code}</code> {diagnostic.message}
    {diagnostic.location ? <span> · {diagnostic.location.sourcePath}:{diagnostic.location.line}:{diagnostic.location.column}</span> : null}
  </li>;
  const status = task?.status ?? (report?.decision === 'canceled' ? 'canceled'
    : report?.decision === 'blocked' || report?.decision === 'repair_required' ? 'blocked' : 'unconfirmed');
  const statusLabels = {
    running: t('designGeneration.running'), repairing: t('designGeneration.repairing'),
    succeeded: t('designGeneration.succeeded'), blocked: t('designGeneration.blocked'),
    canceled: t('designGeneration.canceled'), unconfirmed: t('designGeneration.unconfirmed'),
    awaiting_input: t('designs.status.awaitingInput'),
  };
  const attempt = task?.attempt ?? report!.attempt;
  return <section className={styles.card} data-testid="design-generation-report" data-execution-id={task?.executionId ?? report?.executionId}>
    <div className={styles.heading}><strong>{t('designGeneration.title')}</strong>
      <span data-testid="design-generation-status" data-status={status}>{statusLabels[status]}</span></div>
    <p data-testid="design-generation-attempt" data-attempt={attempt}>{attempt === 0 ? t('designGeneration.initial') : t('designGeneration.repair')}</p>
    {status === 'repairing' ? <p>{t('designGeneration.repairHint')}</p> : null}
    {status === 'blocked' ? <p>{t('designGeneration.blockedHint')}</p> : null}
    {report ? <>
      <p>{t('designGeneration.mode')}: {report.mode} · {t('designGeneration.revision')}: {report.projectRevision}</p>
      <p>{t('designGeneration.decision')}: {report.decision === 'advisory' ? t('designGeneration.advisory')
        : report.decision === 'accepted' ? t('designGeneration.accepted')
          : report.decision === 'not_applicable' ? t('designGeneration.notApplicable')
            : report.decision === 'repair_required' ? t('designGeneration.repairRequired') : statusLabels[report.decision]}</p>
      <p>{report.inventory.complete ? t('designGeneration.inventoryComplete') : t('designGeneration.inventoryIncomplete')}</p>
      {rankedDiagnostics.length ? <ul data-testid="design-generation-diagnostics" className={styles.diagnostics}>
        {rankedDiagnostics.slice(0, 3).map(renderDiagnostic)}
      </ul> : null}
      {rankedDiagnostics.length > 3 ? <details className={styles.moreDiagnostics} data-testid="design-generation-more-diagnostics">
        <summary>{t('designFiles.showMore', { n: rankedDiagnostics.length - 3 })}</summary>
        <ul className={styles.diagnostics}>{rankedDiagnostics.slice(3).map(renderDiagnostic)}</ul>
      </details> : null}
      <details data-testid="design-generation-details"><summary data-testid="design-generation-expand">{t('designGeneration.evidence')}</summary>
        <p>{t('designGeneration.reportHint')}</p>
        <p>{t('designGeneration.changed')}: {report.inventory.changed.join(', ') || t('designGeneration.none')}</p>
        <p>{t('designGeneration.deleted')}: {report.inventory.deleted.join(', ') || t('designGeneration.none')}</p>
        <p>{t('designGeneration.outputs')}: {report.outputs.map(output => output.sourcePath).join(', ') || t('designGeneration.none')}</p>
        <pre data-testid="design-generation-report-json">{JSON.stringify({ task, report }, null, 2)}</pre>
      </details>
    </> : <p>{t('designGeneration.pending')}</p>}
  </section>;
}
