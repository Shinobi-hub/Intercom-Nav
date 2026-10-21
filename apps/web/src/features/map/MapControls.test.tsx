import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLocalStore } from '../../core/store';
import { TID } from '../../core/testIds';
import { MapControls } from './MapControls';

const mode = () => useLocalStore.getState().ui.cameraMode;

beforeEach(() => useLocalStore.getState().reset());
afterEach(cleanup);

describe('MapControls', () => {
  it('toggles between following me and the whole group', () => {
    render(<MapControls />);
    const toggle = screen.getByTestId(TID.mapCameraToggle);
    expect(toggle.dataset.mode).toBe('follow');
    expect(toggle.getAttribute('aria-label')).toBe('Show the whole group');
    expect(screen.queryByTestId(TID.mapRecenter)).toBeNull();
    fireEvent.click(toggle);
    expect(mode()).toBe('group');
    expect(toggle.getAttribute('aria-label')).toBe('Follow me');
    fireEvent.click(toggle);
    expect(mode()).toBe('follow');
  });

  it('offers recenter in free mode, back to the mode used last', () => {
    render(<MapControls />);
    fireEvent.click(screen.getByTestId(TID.mapCameraToggle)); // group
    act(() => useLocalStore.getState().setCameraMode('free'));
    const recenter = screen.getByTestId(TID.mapRecenter);
    expect(recenter.getAttribute('aria-label')).toBe('Show the whole group again');
    fireEvent.click(recenter);
    expect(mode()).toBe('group');
    expect(screen.queryByTestId(TID.mapRecenter)).toBeNull();
  });
});
