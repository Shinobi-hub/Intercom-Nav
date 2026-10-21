import { RIDER_NAME_MAX } from '@intercom/shared';
import type { Ref } from 'react';
import { useId } from 'react';
import { useSettings } from '../../core/store';
import { TID } from '../../core/testIds';
import { ColorPicker } from '../../ui/ColorPicker';
import { cx } from '../../ui/cx';
import { RiderAvatar } from '../../ui/RiderAvatar';
import styles from './start.module.css';

interface IdentityFieldsProps {
  nameError?: string | null;
  onNameEdited?: () => void;
  nameRef?: Ref<HTMLInputElement>;
}

/** Name and color, persisted in settings: what the other riders see on the map and in voice. */
export function IdentityFields({ nameError, onNameEdited, nameRef }: IdentityFieldsProps) {
  const nameId = useId();
  const errorId = useId();
  const name = useSettings((s) => s.name);
  const color = useSettings((s) => s.color);
  const update = useSettings((s) => s.update);

  return (
    <div className={styles.identity}>
      <div className={styles.field}>
        <label htmlFor={nameId} className={styles.label}>
          Your name
        </label>
        <div className={cx(styles.nameBox, nameError && styles.invalid)}>
          <RiderAvatar name={name || '?'} color={color} size="md" />
          <input
            ref={nameRef}
            id={nameId}
            className={styles.nameInput}
            type="text"
            autoComplete="nickname"
            autoCapitalize="words"
            enterKeyHint="done"
            maxLength={RIDER_NAME_MAX}
            placeholder="How the group sees you"
            value={name}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? errorId : undefined}
            data-testid={TID.joinName}
            onChange={(e) => {
              update({ name: e.currentTarget.value });
              onNameEdited?.();
            }}
            onBlur={(e) => update({ name: e.currentTarget.value.trim() })}
          />
        </div>
        {nameError && (
          <p id={errorId} className={styles.fieldError} role="alert">
            {nameError}
          </p>
        )}
      </div>
      <div className={styles.field}>
        <span className={styles.label} aria-hidden="true">
          Your color
        </span>
        <ColorPicker value={color} onChange={(hex) => update({ color: hex })} label="Your color" />
      </div>
    </div>
  );
}
