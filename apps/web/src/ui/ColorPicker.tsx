import { RIDER_COLORS } from '@intercom/shared';
import { Check } from 'lucide-react';
import type { CSSProperties } from 'react';
import { TID } from '../core/testIds';
import { inkOn, riderColorName, sameColor } from './color';
import styles from './ColorPicker.module.css';
import { tapFeedback } from './feedback';

interface ColorPickerProps {
  value: string;
  onChange: (hex: string) => void;
  label?: string;
}

/** The rider palette as large swatches; the chosen one carries a check, not just a ring. */
export function ColorPicker({ value, onChange, label = 'Rider color' }: ColorPickerProps) {
  return (
    <div role="radiogroup" aria-label={label} className={styles.grid}>
      {RIDER_COLORS.map((hex) => {
        const checked = sameColor(hex, value);
        return (
          <button
            key={hex}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={riderColorName(hex)}
            className={styles.swatch}
            style={{ '--swatch': hex, '--swatch-ink': inkOn(hex) } as CSSProperties}
            data-testid={TID.joinColor(hex)}
            onClick={() => {
              tapFeedback();
              onChange(hex);
            }}
          >
            {checked && <Check className={styles.check} aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}
