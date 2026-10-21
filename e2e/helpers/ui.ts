/** UI interactions shared by tests: holds, sheets, sliders, touch-target audit. */
import { expect, type Locator, type Page } from '@playwright/test';
import { TID } from './contract';
import type { Rider } from './rider';
import { sleep, waitFor } from './wait';

type SheetId = 'music' | 'riders' | 'route' | 'settings' | 'share' | 'break';

/**
 * Press and hold an element with the pointer for `ms`, then release. The wait is the hold itself,
 * not an assertion. hover() first runs Playwright's actionability checks (visible, stable, receives
 * events at its center), so a covered button fails loudly instead of holding the wrong element.
 */
export async function holdButton(rider: Rider, testId: string, ms: number): Promise<void> {
  const target = rider.tid(testId);
  await rider.guard(target.hover({ timeout: 10_000 }));
  await rider.page.mouse.down();
  try {
    await sleep(ms);
  } finally {
    await rider.page.mouse.up();
  }
}

/** Buttons that open a sheet directly; everything else goes through the More menu. */
const DIRECT_OPENERS: Partial<Record<SheetId, string>> = { music: TID.dockMusic };

async function becomesVisible(locator: Locator, timeout: number): Promise<boolean> {
  return locator.waitFor({ state: 'visible', timeout }).then(
    () => true,
    () => false,
  );
}

/** Opens a sheet (direct opener first, then More → menu item) and returns it. */
export async function openSheet(rider: Rider, id: SheetId): Promise<Locator> {
  const sheet = rider.tid(TID.sheet(id));
  if (await sheet.isVisible()) return sheet;
  const direct = DIRECT_OPENERS[id];
  if (direct) {
    await rider.tid(direct).click();
    if (await becomesVisible(sheet, 3_000)) return sheet;
  }
  await rider.tid(TID.dockMore).click();
  const item = rider.tid(TID.menuItem(id));
  await expect(item, `[${rider.name}] More menu should offer ${TID.menuItem(id)}`).toBeVisible();
  await item.click();
  await expect(sheet, `[${rider.name}] ${TID.sheet(id)} should open`).toBeVisible();
  return sheet;
}

export async function closeSheet(rider: Rider, id: SheetId): Promise<void> {
  const sheet = rider.tid(TID.sheet(id));
  if (!(await sheet.isVisible())) return;
  await sheet.getByTestId(TID.sheetClose).or(rider.tid(TID.sheetClose)).first().click();
  await expect(sheet, `[${rider.name}] ${TID.sheet(id)} should close`).toBeHidden();
}

/**
 * Sets an <input type=range> the way a user drag would: through the native value setter (React
 * tracks the instance setter and would swallow the change) followed by input + change events.
 */
export async function setRange(locator: Locator, value: number): Promise<void> {
  await locator.evaluate((el, v) => {
    if (!(el instanceof HTMLInputElement) || el.type !== 'range') {
      throw new Error(`expected <input type="range">, found <${el.tagName.toLowerCase()}${el instanceof HTMLInputElement ? ` type="${el.type}"` : ''}>`);
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

/** Range bounds, so callers can map a 0..1 setting onto a 0..1 or 0..100 slider. */
export async function rangeBounds(locator: Locator): Promise<{ min: number; max: number }> {
  return locator.evaluate((el) => {
    const input = el as HTMLInputElement;
    return { min: Number(input.min || 0), max: Number(input.max || 100) };
  });
}

/** Waits until a locator's attribute equals `value`; returns false on timeout (no assertion). */
export async function attributeBecomes(locator: Locator, name: string, value: string, timeout: number): Promise<boolean> {
  try {
    await expect(locator).toHaveAttribute(name, value, { timeout });
    return true;
  } catch {
    return false;
  }
}

// ---- touch-target audit -----------------------------------------------------------------------

export interface TouchTargetIssue {
  what: string;
  width: number;
  height: number;
  required: number;
}

export interface TouchAuditOptions {
  /** Minimum for every interactive element (CSS px, both dimensions). */
  min?: number;
  /** Larger minimum for specific test ids (the dock). */
  strict?: Record<string, number>;
  /** Subtrees to skip, e.g. third-party map attribution. */
  ignore?: string[];
}

/** Every visible interactive element whose hit area (its box plus any ::before/::after extension) is under the minimum in either dimension. */
export async function auditTouchTargets(page: Page, opts: TouchAuditOptions = {}): Promise<TouchTargetIssue[]> {
  return page.evaluate(
    ({ min, strict, ignore }) => {
      const SELECTOR = [
        'button',
        'a[href]',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        'summary',
        'label',
        '[role="button"]',
        '[role="link"]',
        '[role="switch"]',
        '[role="checkbox"]',
        '[role="radio"]',
        '[role="slider"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="option"]',
        '[tabindex]:not([tabindex="-1"])',
      ].join(',');
      const shown = (el: Element) => {
        const r = el.getBoundingClientRect();
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && r.width * r.height > 4;
      };
      const all = Array.from(document.querySelectorAll<HTMLElement>(SELECTOR)).filter((el) => {
        if (!(el instanceof HTMLLabelElement)) return true;
        // A label is a touch target when it wraps its control or stands in for a visually hidden one
        // (custom toggles). A caption next to its own visible control isn't: the control is audited.
        const control = el.control;
        return control !== null && (el.contains(control) || !shown(control));
      });
      const candidates = new Set(all);
      /** The element's box grown by any ::before/::after hit-area extension (map markers keep their root at the disc size). */
      const hitBox = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        let { left, top, right, bottom } = r;
        for (const pseudo of ['::before', '::after']) {
          const cs = getComputedStyle(el, pseudo);
          if (cs.content === 'none' || cs.content === 'normal' || cs.display === 'none' || cs.pointerEvents === 'none' || cs.position !== 'absolute') continue;
          const l = r.left + parseFloat(cs.left);
          const t = r.top + parseFloat(cs.top);
          const w = parseFloat(cs.width);
          const h = parseFloat(cs.height);
          if (![l, t, w, h].every(Number.isFinite)) continue;
          left = Math.min(left, l);
          top = Math.min(top, t);
          right = Math.max(right, l + w);
          bottom = Math.max(bottom, t + h);
        }
        return { width: right - left, height: bottom - top };
      };
      const issues: { what: string; width: number; height: number; required: number }[] = [];
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const describe = (el: HTMLElement) => {
        const tid = el.getAttribute('data-testid');
        const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        return `<${el.tagName.toLowerCase()}${tid ? ` data-testid="${tid}"` : ''}>${label ? ` "${label}"` : ''}`;
      };
      for (const el of all) {
        if (ignore.some((sel) => el.closest(sel))) continue;
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
        const r = el.getBoundingClientRect();
        // Visually hidden (sr-only) controls aren't touch targets; their label is.
        if (r.width * r.height <= 4) continue;
        if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
        const tid = el.getAttribute('data-testid');
        const required = (tid && strict[tid]) || min;
        // A small control inside a big enough interactive parent (label, button) uses the parent's hit area.
        let parent = el.parentElement;
        let coveredByParent = false;
        while (parent) {
          if (candidates.has(parent)) {
            const pr = hitBox(parent);
            coveredByParent = pr.width >= required && pr.height >= required;
            break;
          }
          parent = parent.parentElement;
        }
        if (coveredByParent) continue;
        const hit = hitBox(el);
        if (hit.width < required - 0.5 || hit.height < required - 0.5) {
          issues.push({ what: describe(el), width: Math.round(hit.width), height: Math.round(hit.height), required });
        }
      }
      return issues;
    },
    { min: opts.min ?? 56, strict: opts.strict ?? {}, ignore: opts.ignore ?? [] },
  );
}

/** Waits until none of `locators` is visible (for "gone everywhere" checks across riders). */
export async function expectAllHidden(rider: Rider, testIds: string[], timeout: number): Promise<void> {
  await waitFor(
    async () => {
      for (const id of testIds) if (await rider.tid(id).isVisible()) return false;
      return true;
    },
    { timeout, message: `[${rider.name}] ${testIds.join(', ')} should all be hidden` },
  );
}
