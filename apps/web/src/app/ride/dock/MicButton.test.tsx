import type { MicMode } from '@intercom/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettings } from '../../../core/store';
import { TID } from '../../../core/testIds';
import { installTestServices, resetStores } from '../../../ui/testing';
import { MicButton } from './MicButton';

/** Mirrors the real controller: settings track the mode, and liveMicMode the last non-off one. */
const setMicMode = vi.fn(async (mode: MicMode) => {
  useSettings.getState().update(mode === 'off' ? { micMode: mode } : { micMode: mode, liveMicMode: mode });
});

describe('MicButton', () => {
  beforeEach(() => {
    setMicMode.mockClear();
    resetStores();
    installTestServices({ setMicMode });
  });
  afterEach(cleanup);

  it('mutes from VOX and shows MUTED', async () => {
    render(<MicButton />);
    const mic = screen.getByTestId(TID.dockMic);
    expect(mic.dataset.mode).toBe('vox');
    expect(mic.textContent).toBe('VOX');
    await act(async () => fireEvent.click(mic));
    expect(setMicMode).toHaveBeenLastCalledWith('off');
    expect(mic.dataset.mode).toBe('off');
    expect(mic.textContent).toBe('MUTED');
  });

  it('unmutes back to the configured live mode', async () => {
    useSettings.getState().update({ micMode: 'off', liveMicMode: 'open' });
    render(<MicButton />);
    const mic = screen.getByTestId(TID.dockMic);
    await act(async () => fireEvent.click(mic));
    expect(setMicMode).toHaveBeenLastCalledWith('open');
    expect(mic.dataset.mode).toBe('open');
    expect(mic.textContent).toBe('OPEN');
  });

  it('exposes the mic state from the audio engine', () => {
    render(<MicButton />);
    expect(screen.getByTestId(TID.dockMic).dataset.state).toBe('off');
  });
});
