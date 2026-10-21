import { create as createQr } from 'qrcode';
import { useMemo } from 'react';

interface QrCodeProps {
  value: string;
  /** Rendered size in px; the code scales crisply. */
  size: number;
  label: string;
  testId?: string;
  className?: string;
}

/** Quiet zone required around the symbol, in modules. */
const QUIET = 4;

/** Dark modules as one SVG path, merging horizontal runs to keep the path short. */
function modulesPath(value: string): { path: string; size: number } {
  const { modules } = createQr(value, { errorCorrectionLevel: 'M' });
  const n = modules.size;
  let path = '';
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!modules.get(y, x)) {
        x++;
        continue;
      }
      const start = x;
      while (x < n && modules.get(y, x)) x++;
      path += `M${start + QUIET} ${y + QUIET}h${x - start}v1h-${x - start}z`;
    }
  }
  return { path, size: n + QUIET * 2 };
}

/** Black on white regardless of theme: phone cameras need the contrast. */
export function QrCode({ value, size, label, testId, className }: QrCodeProps) {
  const qr = useMemo(() => modulesPath(value), [value]);
  return (
    <svg
      className={className}
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      data-testid={testId}
      data-value={value}
    >
      <rect width={qr.size} height={qr.size} fill="#ffffff" />
      <path d={qr.path} fill="#000000" />
    </svg>
  );
}
