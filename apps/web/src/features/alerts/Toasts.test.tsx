import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocalStore } from '../../core/store';
import { TID } from '../../core/testIds';
import { installTestServices, resetStores } from '../../ui/testing';
import { Toasts } from './Toasts';

const push = (t: Parameters<ReturnType<typeof useLocalStore.getState>['pushToast']>[0]) =>
  act(() => {
    useLocalStore.getState().pushToast(t);
  });

describe('Toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installTestServices();
    resetStores();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('auto-dismisses after ttlMs', () => {
    render(<Toasts />);
    push({ kind: 'break', title: 'Arjun wants a fuel stop', ttlMs: 3_000 });
    const toast = screen.getByTestId(TID.toast);
    expect(toast.dataset.kind).toBe('break');
    act(() => vi.advanceTimersByTime(2_999));
    expect(screen.queryByTestId(TID.toast)).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId(TID.toast)).toBeNull();
  });

  it('keeps ttlMs 0 toasts until tapped', () => {
    render(<Toasts />);
    push({ kind: 'warning', title: 'No GPS signal', ttlMs: 0 });
    act(() => vi.advanceTimersByTime(60_000));
    fireEvent.click(screen.getByTestId(TID.toast));
    expect(screen.queryByTestId(TID.toast)).toBeNull();
    expect(useLocalStore.getState().ui.toasts).toHaveLength(0);
  });
});
