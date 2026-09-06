import { DESIGN_LOOM_PRODUCT } from '@open-design/contracts';
import { useT } from '../i18n';
import styles from './ProductIdentity.module.css';

export function ProductIdentity() {
  const t = useT();
  return (
    <div className={styles.identity}>
      <img src="/design-loom.svg" alt="" width={56} height={56} />
      <div>
        <h3>{DESIGN_LOOM_PRODUCT.name}</h3>
        <p className="hint">{t('app.brandSubtitle')}</p>
        <a href={DESIGN_LOOM_PRODUCT.repositoryUrl} target="_blank" rel="noreferrer noopener">GitHub</a>
      </div>
    </div>
  );
}
