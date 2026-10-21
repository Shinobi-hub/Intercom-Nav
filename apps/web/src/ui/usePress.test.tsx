import { TIMING } from '@intercom/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SosButton } from '../app/ride/dock/SosButton';
import { useRideStore } from '../core/store';
import { TID } from '../core/testIds';
import { installTestServices, resetStores, testRider } from './testing';
import { usePress, type PressOptions } from './usePress';

function Probe(props: Omit<PressOptions, 'holdMs'>) {
  const { pressing, bind } = usePress({ holdMs: 1_500, ...props });
  return (
    <button type="button" data-pressing={pressing} {...bind}>
      hold
    </button>
  );
}

const down = (el: Element) => fireEvent.pointerDown(el, { pointerId: 1, button: 0, pointerType: 'touch' });
const up = (el: Element) => fireEvent.pointerUp(el, { pointerId: 1, button: 0, pointerType: 'touch' });
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('hold to confirm', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installTestServices();
    resetStores();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('fires only after the full hold', () => {
    const onHold = vi.fn();
    render(<Probe onHold={onHold} />);
    const button = screen.getByRole('button');
    down(button);
    expect(button.dataset.pressing).toBe('true');
    advance(1_499);
    expect(onHold).not.toHaveBeenCalled();
    advance(1);
    expect(onHold).toHaveBeenCalledTimes(1);
    up(button);
    advance(5_000);
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it('cancels on early release', () => {
    const onHold = vi.fn();
    const onCancel = vi.fn();
    render(<Probe onHold={onHold} onCancel={onCancel} />);
    const button = screen.getByRole('button');
    down(button);
    advance(1_000);
    up(button);
    advance(2_000);
    expect(onHold).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(button.dataset.pressing).toBe('false');
  });

  it('cancels when the pointer leaves or is cancelled', () => {
    const onHold = vi.fn();
    render(<Probe onHold={onHold} />);
    const button = screen.getByRole('button');
    down(button);
    advance(500);
    fireEvent.pointerLeave(button, { pointerId: 1, pointerType: 'touch' });
    advance(2_000);
    down(button);
    advance(500);
    fireEvent.pointerCancel(button, { pointerId: 1, pointerType: 'touch' });
    advance(2_000);
    expect(onHold).not.toHaveBeenCalled();
  });

  it('works by holding Space or Enter, and a short key press only taps', () => {
    const onHold = vi.fn();
    const onTap = vi.fn();
    render(<Probe onHold={onHold} onTap={onTap} />);
    const button = screen.getByRole('button');
    fireEvent.keyDown(button, { key: ' ' });
    advance(1_500);
    expect(onHold).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(button, { key: ' ' });

    fireEvent.keyDown(button, { key: 'Enter' });
    advance(400);
    fireEvent.keyUp(button, { key: 'Enter' });
    advance(2_000);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('raises an SOS from the dock only after TIMING.sosHoldMs', () => {
    const raiseSos = vi.fn(async () => {});
    installTestServices({ raiseSos });
    render(<SosButton />);
    const sos = screen.getByTestId(TID.dockSos);
    expect(sos.dataset.active).toBe('false');
    down(sos);
    expect(sos.dataset.holding).toBe('true');
    advance(TIMING.sosHoldMs - 1);
    expect(raiseSos).not.toHaveBeenCalled();
    advance(1);
    expect(raiseSos).toHaveBeenCalledTimes(1);
  });

  it('shows SOS ACTIVE and ignores holds while my own SOS is active', () => {
    const raiseSos = vi.fn(async () => {});
    installTestServices({ raiseSos });
    const self = '11111111-1111-4111-8111-111111111111';
    useRideStore.setState({ selfId: self, riders: { [self]: testRider(self, 'Me') } });
    useRideStore.getState().upsertSos({ id: 'sos-1', riderId: self, location: null, raisedAt: 1, responders: [] }, 'local');
    render(<SosButton />);
    const sos = screen.getByTestId(TID.dockSos);
    expect(sos.dataset.active).toBe('true');
    expect(sos.textContent).toContain('SOS ACTIVE');
    down(sos);
    advance(TIMING.sosHoldMs * 2);
    expect(raiseSos).not.toHaveBeenCalled();
  });
});
