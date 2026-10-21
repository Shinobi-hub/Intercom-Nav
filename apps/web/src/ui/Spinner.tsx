import styles from './Spinner.module.css';

export function Spinner({ size = 22 }: { size?: number }) {
  return <span className={styles.spinner} style={{ width: size, height: size }} aria-hidden="true" />;
}
