/**
 * One gesture model for every press-and-hold control (SOS, cancel SOS, Break, Music).
 *
 * A press starts on pointerdown (mouse, touch or pen) or on keydown of Space/Enter, and then:
 *  - lasting `holdMs` fires `onHold` (hold-to-confirm, long-press);
 *  - releasing earlier fires `onTap`, or just cancels when there is no `onTap` (hold-only controls);
 *  - sliding off the control, a pointercancel or losing focus cancels without firing anything.
 *
 * The native click that follows a pointer release is swallowed so nothing fires twice. A click with
 * no press before it (screen readers, programmatic clicks) counts as a tap.
 */
import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

export interface PressOptions {
  /** How long the press must last before `onHold` fires. */
  holdMs: number;
  onHold: () => void;
  /** Fires for a press released before `holdMs`. Without it an early release only cancels. */
  onTap?: () => void;
  onPressStart?: () => void;
  /** The press ended without a hold (released early with no onTap, slid off, or interrupted). */
  onCancel?: () => void;
  /** Called every `tickMs` while the press lasts (haptic ticks). */
  onTick?: () => void;
  tickMs?: number;
  disabled?: boolean;
}

export interface PressBindings {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (e: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  onKeyUp: (e: KeyboardEvent<HTMLElement>) => void;
  onBlur: (e: FocusEvent<HTMLElement>) => void;
  onClick: (e: MouseEvent<HTMLElement>) => void;
  onContextMenu: (e: MouseEvent<HTMLElement>) => void;
}

type Phase = 'idle' | 'pressing' | 'held';

/** A click this soon after a press ended belongs to that press. */
const CLICK_AFTER_PRESS_MS = 800;
const PRESS_KEYS = new Set([' ', 'Enter']);

export function usePress(options: PressOptions): { pressing: boolean; bind: PressBindings } {
  const opts = useRef(options);
  useEffect(() => {
    opts.current = options;
  });

  const [pressing, setPressing] = useState(false);
  const s = useRef({
    phase: 'idle' as Phase,
    pointerId: null as number | null,
    key: null as string | null,
    holdTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    tickTimer: undefined as ReturnType<typeof setInterval> | undefined,
    endedAt: -Infinity,
  });

  function clearTimers() {
    clearTimeout(s.current.holdTimer);
    clearInterval(s.current.tickTimer);
    s.current.holdTimer = undefined;
    s.current.tickTimer = undefined;
  }

  useEffect(() => clearTimers, []);

  // Disabling mid-press (e.g. the SOS went active elsewhere) abandons the press quietly.
  useEffect(() => {
    if (options.disabled && s.current.phase === 'pressing') {
      clearTimers();
      reset();
    }
  });

  function reset() {
    const st = s.current;
    st.phase = 'idle';
    st.pointerId = null;
    st.key = null;
    st.endedAt = performance.now();
    setPressing(false);
  }

  function begin(): boolean {
    const o = opts.current;
    if (o.disabled || s.current.phase !== 'idle') return false;
    s.current.phase = 'pressing';
    setPressing(true);
    o.onPressStart?.();
    s.current.holdTimer = setTimeout(() => {
      clearTimers();
      s.current.phase = 'held';
      setPressing(false);
      opts.current.onHold();
    }, o.holdMs);
    if (o.onTick) s.current.tickTimer = setInterval(() => opts.current.onTick?.(), o.tickMs ?? 250);
    return true;
  }

  /** Finger lifted or key released. */
  function release() {
    const wasPressing = s.current.phase === 'pressing';
    clearTimers();
    reset();
    if (!wasPressing) return;
    const o = opts.current;
    if (o.onTap) o.onTap();
    else o.onCancel?.();
  }

  /** Slid off, interrupted, or lost focus. */
  function abort() {
    const wasPressing = s.current.phase === 'pressing';
    clearTimers();
    if (s.current.phase === 'idle') return;
    reset();
    if (wasPressing) opts.current.onCancel?.();
  }

  const bind: PressBindings = {
    onPointerDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (s.current.phase !== 'idle') return;
      // Touch input is implicitly captured by the pressed element, which suppresses pointerleave.
      // Releasing the capture lets "slide off to cancel" work for fingers as well as the mouse.
      const el = e.currentTarget;
      if (typeof el.hasPointerCapture === 'function' && el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
      if (begin()) s.current.pointerId = e.pointerId;
    },
    onPointerUp(e) {
      if (e.pointerId === s.current.pointerId) release();
    },
    onPointerLeave(e) {
      if (e.pointerId === s.current.pointerId) abort();
    },
    onPointerCancel(e) {
      if (e.pointerId === s.current.pointerId) abort();
    },
    onKeyDown(e) {
      if (!PRESS_KEYS.has(e.key)) return;
      // No native click for Space/Enter: the press handles activation.
      e.preventDefault();
      if (e.repeat || s.current.phase !== 'idle') return;
      if (begin()) s.current.key = e.key;
    },
    onKeyUp(e) {
      if (e.key !== s.current.key) return;
      e.preventDefault();
      release();
    },
    onBlur() {
      abort();
    },
    onClick(e) {
      if (performance.now() - s.current.endedAt < CLICK_AFTER_PRESS_MS) {
        e.preventDefault();
        return;
      }
      if (opts.current.disabled) return;
      opts.current.onTap?.();
    },
    onContextMenu(e) {
      // A long touch would otherwise pop the context menu or start a text selection.
      e.preventDefault();
    },
  };

  return { pressing, bind };
}
