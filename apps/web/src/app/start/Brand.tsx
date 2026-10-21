import styles from './start.module.css';

export function Brand() {
  return (
    <div className={styles.brand}>
      <img src="/icon.svg" alt="" width={36} height={36} />
      <span>Intercom Nav</span>
    </div>
  );
}
