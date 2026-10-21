import type { MicMode, VoiceMode } from '@intercom/shared';
import { RIDER_NAME_MAX } from '@intercom/shared';
import { LogOut } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useId, useState } from 'react';
import type { AudioDevices } from '../../core/services';
import { getServices } from '../../core/services';
import type { MapTheme, Units } from '../../core/store';
import { useLocalStore, useRideStore, useSettings } from '../../core/store';
import { TID } from '../../core/testIds';
import { MicLevelMeter } from '../../features/audio';
import { Button } from '../../ui/Button';
import { ColorPicker } from '../../ui/ColorPicker';
import { errorFeedback } from '../../ui/feedback';
import { Segmented } from '../../ui/Segmented';
import { Slider } from '../../ui/Slider';
import { Toggle } from '../../ui/Toggle';
import styles from './sheets.module.css';

const MIC_HELP: Record<MicMode, string> = {
  vox: 'Sends your voice only while you speak. Best for most rides.',
  open: 'Always sending, like a phone call. Use it in very quiet conditions.',
  off: 'Microphone released, so Bluetooth music plays at full quality. You still hear the group.',
};

const ARM_LEAVE_MS = 5_000;

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 id={id} className={styles.sectionTitle}>
        {title}
      </h3>
      {children}
    </section>
  );
}

export function SettingsSheet() {
  return (
    <div className={styles.settings}>
      <ProfileSection />
      <MicSection />
      <AudioSection />
      <MapSection />
      <VoiceSection />
      <LeaveSection />
    </div>
  );
}

function ProfileSection() {
  const nameId = useId();
  const savedName = useSettings((s) => s.name);
  const color = useSettings((s) => s.color);
  const [name, setName] = useState(savedName);
  useEffect(() => setName(savedName), [savedName]);

  function commitName() {
    const next = name.trim();
    if (!next) {
      setName(savedName);
      return;
    }
    if (next !== savedName) void getServices().controller.updateProfile({ name: next });
  }

  return (
    <Section title="Rider">
      <div className={styles.field}>
        <label htmlFor={nameId} className={styles.fieldLabel}>
          Name
        </label>
        <input
          id={nameId}
          className={styles.textInput}
          type="text"
          autoComplete="nickname"
          maxLength={RIDER_NAME_MAX}
          enterKeyHint="done"
          value={name}
          data-testid={TID.joinName}
          onChange={(e) => setName(e.currentTarget.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      </div>
      <div className={styles.field}>
        <span className={styles.fieldLabel} aria-hidden="true">
          Color
        </span>
        <ColorPicker value={color} label="Your color" onChange={(hex) => void getServices().controller.updateProfile({ color: hex })} />
      </div>
    </Section>
  );
}

function MicSection() {
  const micMode = useSettings((s) => s.micMode);
  const sensitivity = useSettings((s) => s.vadSensitivity);
  const micState = useLocalStore((s) => s.audio.micState);

  return (
    <Section title="Microphone">
      <Segmented<MicMode>
        label="Microphone mode"
        value={micMode}
        options={[
          { value: 'vox', label: 'VOX', testId: TID.settingsMicMode('vox') },
          { value: 'open', label: 'Open', testId: TID.settingsMicMode('open') },
          { value: 'off', label: 'Off', testId: TID.settingsMicMode('off') },
        ]}
        onChange={(mode) => void getServices().controller.setMicMode(mode)}
      />
      <p className={styles.help}>{MIC_HELP[micMode]}</p>
      {micState === 'denied' && (
        <p className={styles.warning}>The browser blocked the microphone. Allow it in site settings, then pick VOX again.</p>
      )}
      <Slider
        label="Voice sensitivity"
        value={sensitivity}
        testId={TID.settingsSensitivity}
        hint="Higher picks up quiet speech; lower ignores more wind and engine noise."
        onChange={(v) => useSettings.getState().update({ vadSensitivity: v })}
      />
      <MicLevelMeter />
    </Section>
  );
}

function AudioSection() {
  const duckLevel = useSettings((s) => s.duckLevel);
  const duckOnOwnVoice = useSettings((s) => s.duckOnOwnVoice);
  const voiceVolume = useSettings((s) => s.voiceVolume);
  const musicVolume = useSettings((s) => s.musicVolume);
  const update = useSettings((s) => s.update);

  return (
    <Section title="Audio">
      <Slider
        label="Music volume while talking"
        value={duckLevel}
        testId={TID.settingsDuckLevel}
        hint="How loud music stays while someone speaks."
        onChange={(v) => update({ duckLevel: v })}
      />
      <Toggle
        label="Lower music when I talk"
        description="Not only when others do."
        checked={duckOnOwnVoice}
        onChange={(v) => update({ duckOnOwnVoice: v })}
        testId={TID.settingsDuckOwnVoice}
      />
      <Slider label="Voice volume" value={voiceVolume} onChange={(v) => update({ voiceVolume: v })} />
      <Slider label="Music volume" value={musicVolume} onChange={(v) => update({ musicVolume: v })} />
      <DevicePickers />
    </Section>
  );
}

function DevicePickers() {
  const inputId = useId();
  const outputId = useId();
  const inputDeviceId = useSettings((s) => s.inputDeviceId);
  const outputDeviceId = useSettings((s) => s.outputDeviceId);
  const update = useSettings((s) => s.update);
  const [devices, setDevices] = useState<AudioDevices | null>(null);

  useEffect(() => {
    let alive = true;
    getServices()
      .audio.listDevices()
      .then((d) => alive && setDevices(d))
      .catch(() => alive && setDevices({ inputs: [], outputs: [], canSelectOutput: false }));
    return () => {
      alive = false;
    };
  }, []);

  if (!devices) return null;
  const label = (d: MediaDeviceInfo, i: number, kind: string) => d.label || `${kind} ${i + 1}`;

  return (
    <>
      <div className={styles.field}>
        <label htmlFor={inputId} className={styles.fieldLabel}>
          Microphone
        </label>
        <select
          id={inputId}
          className={styles.select}
          value={inputDeviceId ?? ''}
          onChange={(e) => update({ inputDeviceId: e.currentTarget.value || null })}
        >
          <option value="">System default</option>
          {devices.inputs.map((d, i) => (
            <option key={d.deviceId || i} value={d.deviceId}>
              {label(d, i, 'Microphone')}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <label htmlFor={outputId} className={styles.fieldLabel}>
          Output
        </label>
        {devices.canSelectOutput ? (
          <select
            id={outputId}
            className={styles.select}
            value={outputDeviceId ?? ''}
            onChange={(e) => update({ outputDeviceId: e.currentTarget.value || null })}
          >
            <option value="">System default</option>
            {devices.outputs.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {label(d, i, 'Speaker')}
              </option>
            ))}
          </select>
        ) : (
          <p id={outputId} className={styles.help}>
            This device sends sound to its current output. Pair your helmet in Bluetooth settings.
          </p>
        )}
      </div>
    </>
  );
}

function MapSection() {
  const announce = useSettings((s) => s.announce);
  const units = useSettings((s) => s.units);
  const headingUp = useSettings((s) => s.headingUp);
  const mapTheme = useSettings((s) => s.mapTheme);
  const update = useSettings((s) => s.update);

  return (
    <Section title="Alerts and map">
      <Toggle
        label="Spoken alerts"
        description="Reads SOS, stops and route changes aloud in your helmet."
        checked={announce}
        testId={TID.settingsAnnounce}
        onChange={(v) => update({ announce: v })}
      />
      <div className={styles.field}>
        <span className={styles.fieldLabel} aria-hidden="true">
          Units
        </span>
        <Segmented<Units>
          label="Units"
          value={units}
          testId={TID.settingsUnits}
          options={[
            { value: 'metric', label: 'km' },
            { value: 'imperial', label: 'miles' },
          ]}
          onChange={(v) => update({ units: v })}
        />
      </div>
      <Toggle
        label="Heading up"
        description="Turn the map with your direction of travel."
        checked={headingUp}
        onChange={(v) => update({ headingUp: v })}
      />
      <div className={styles.field}>
        <span className={styles.fieldLabel} aria-hidden="true">
          Map colors
        </span>
        <Segmented<MapTheme>
          label="Map colors"
          value={mapTheme}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'day', label: 'Day' },
            { value: 'night', label: 'Night' },
          ]}
          onChange={(v) => update({ mapTheme: v })}
        />
      </div>
    </Section>
  );
}

function VoiceSection() {
  const voiceMode = useRideStore((s) => s.ride?.voiceMode ?? 'livekit');
  const isLeader = useRideStore((s) => s.selfId !== null && s.selfId === s.ride?.leaderId);
  const [pending, setPending] = useState(false);

  async function choose(mode: VoiceMode) {
    setPending(true);
    const res = await getServices().controller.setVoiceMode(mode);
    setPending(false);
    if (!res.ok) {
      errorFeedback();
      useLocalStore.getState().pushToast({
        kind: 'error',
        title: "Couldn't switch voice",
        body:
          res.error === 'unavailable'
            ? 'This server has no LiveKit set up. Rider-to-rider voice still works.'
            : (res.message ?? 'Try again in a moment.'),
      });
    }
  }

  return (
    <Section title="Voice connection">
      <Segmented<VoiceMode>
        label="Voice connection"
        value={voiceMode}
        disabled={!isLeader || pending}
        options={[
          { value: 'livekit', label: 'Server', testId: TID.settingsVoiceMode('livekit') },
          { value: 'mesh', label: 'Direct', testId: TID.settingsVoiceMode('mesh') },
        ]}
        onChange={(mode) => void choose(mode)}
      />
      <p className={styles.help}>
        {voiceMode === 'livekit'
          ? 'Through the LiveKit server: steady with many riders.'
          : 'Rider to rider (mesh): no media server, best for small groups.'}{' '}
        {isLeader ? 'Switching moves everyone.' : 'Only the leader can switch this.'}
      </p>
    </Section>
  );
}

function LeaveSection() {
  const [armed, setArmed] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARM_LEAVE_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <Section title="Ride">
      <Button
        variant="danger"
        size="lg"
        block
        icon={LogOut}
        busy={leaving}
        data-testid={TID.settingsLeave}
        data-armed={armed}
        onClick={() => {
          if (!armed) {
            setArmed(true);
            return;
          }
          setLeaving(true);
          void getServices().controller.leaveRide();
        }}
      >
        {armed ? 'Tap again to leave' : 'Leave ride'}
      </Button>
      <p className={styles.help}>
        {armed
          ? 'You stop sharing your location and voice with the group.'
          : 'Leaving asks for a second tap, so a bump on the road won’t drop you.'}
      </p>
    </Section>
  );
}
