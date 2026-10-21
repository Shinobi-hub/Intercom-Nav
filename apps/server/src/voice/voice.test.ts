import { createHmac } from 'node:crypto';
import { TokenVerifier } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';
import type { Config } from '../config';
import { buildIceServers, coturnCredentials, TURN_CREDENTIAL_TTL_S, type IceConfig } from './ice';
import { LIVEKIT_TOKEN_TTL_S, liveKitRoomName, mintLiveKitToken } from './livekit';
import { createVoiceService } from './service';

const NOW = 1_750_000_000_000;
const RIDER = '0b9f6f1e-2c36-4f5c-9f63-6f1d2a8b7c11';

function decodeJwt(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

const noTurn: IceConfig = { stunUrls: [], turnUrls: [], turnUsername: null, turnCredential: null, turnSecret: null };

describe('ICE servers', () => {
  it('lists STUN servers', () => {
    expect(buildIceServers({ ...noTurn, stunUrls: ['stun:a:3478', 'stun:b:3478'] }, RIDER, NOW)).toEqual([
      { urls: ['stun:a:3478', 'stun:b:3478'] },
    ]);
    expect(buildIceServers(noTurn, RIDER, NOW)).toEqual([]);
  });

  it('adds static TURN credentials', () => {
    const servers = buildIceServers(
      { ...noTurn, turnUrls: ['turn:t:3478'], turnUsername: 'user', turnCredential: 'pass' },
      RIDER,
      NOW,
    );
    expect(servers).toEqual([{ urls: ['turn:t:3478'], username: 'user', credential: 'pass' }]);
  });

  it('mints coturn REST credentials from TURN_SECRET', () => {
    const { username, credential } = coturnCredentials('s3cret', RIDER, NOW);
    const expiry = Math.floor(NOW / 1000) + TURN_CREDENTIAL_TTL_S;
    expect(TURN_CREDENTIAL_TTL_S).toBe(12 * 3600);
    expect(username).toBe(`${expiry}:${RIDER}`);
    expect(credential).toBe(createHmac('sha1', 's3cret').update(username).digest('base64'));
    // Known-answer check, independent of the implementation above.
    expect(coturnCredentials('north', 'rider', 0, 3600)).toEqual({
      username: '3600:rider',
      credential: createHmac('sha1', 'north').update('3600:rider').digest('base64'),
    });
    const servers = buildIceServers({ ...noTurn, turnUrls: ['turns:t:5349'], turnSecret: 's3cret' }, RIDER, NOW);
    expect(servers).toEqual([{ urls: ['turns:t:5349'], username, credential }]);
  });

  it('prefers static credentials when both kinds are configured', () => {
    const servers = buildIceServers(
      { ...noTurn, turnUrls: ['turn:t'], turnUsername: 'u', turnCredential: 'p', turnSecret: 's' },
      RIDER,
      NOW,
    );
    expect(servers).toEqual([{ urls: ['turn:t'], username: 'u', credential: 'p' }]);
  });

  it('never emits TURN without credentials (browsers would reject the whole config)', () => {
    expect(buildIceServers({ ...noTurn, turnUrls: ['turn:t:3478'], turnUsername: 'only-user' }, RIDER, NOW)).toEqual([]);
  });
});

describe('LiveKit tokens', () => {
  it('grants mic + data publishing in the ride room only', async () => {
    const token = await mintLiveKitToken(
      { apiKey: 'devkey', apiSecret: 'secret' },
      { room: liveKitRoomName('ABCD23'), identity: RIDER, name: 'Alice' },
    );
    const claims = decodeJwt(token);
    expect(claims).toMatchObject({ iss: 'devkey', sub: RIDER, name: 'Alice' });
    expect(claims.video).toEqual({
      roomJoin: true,
      room: 'ride-ABCD23',
      canPublish: true,
      canPublishSources: ['microphone'],
      canPublishData: true,
      canSubscribe: true,
    });
    expect((claims.exp as number) - (claims.nbf as number)).toBe(LIVEKIT_TOKEN_TTL_S);
    expect(LIVEKIT_TOKEN_TTL_S).toBe(6 * 3600);

    const verified = await new TokenVerifier('devkey', 'secret').verify(token);
    expect(verified.sub).toBe(RIDER);
    await expect(new TokenVerifier('devkey', 'wrong').verify(token)).rejects.toThrow();
  });
});

describe('voice service', () => {
  const base: Config['voice'] = {
    livekit: null,
    defaultMode: 'livekit',
    stunUrls: ['stun:stun.example:3478'],
    turnUrls: [],
    turnUsername: null,
    turnCredential: null,
    turnSecret: null,
  };
  const withLiveKit: Config['voice'] = { ...base, livekit: { url: 'ws://127.0.0.1:7880', apiKey: 'devkey', apiSecret: 'secret' } };

  it('offers mesh only without LiveKit', async () => {
    const voice = createVoiceService(base, () => NOW);
    expect(voice.available).toEqual(['mesh']);
    expect(voice.defaultMode).toBe('mesh');
    expect(voice.liveKitEnabled).toBe(false);
    expect(voice.resolveMode('livekit')).toBe('mesh');
    expect(await voice.liveKit('ABCD23', RIDER, 'A')).toBeNull();
  });

  it('picks the requested mode if available, else the default', () => {
    const voice = createVoiceService(withLiveKit, () => NOW);
    expect(voice.available).toEqual(['livekit', 'mesh']);
    expect(voice.resolveMode(undefined)).toBe('livekit');
    expect(voice.resolveMode('mesh')).toBe('mesh');
    const meshDefault = createVoiceService({ ...withLiveKit, defaultMode: 'mesh' }, () => NOW);
    expect(meshDefault.resolveMode(undefined)).toBe('mesh');
    expect(meshDefault.resolveMode('livekit')).toBe('livekit');
  });

  it('builds join info with credentials only in livekit mode', async () => {
    const voice = createVoiceService(withLiveKit, () => NOW);
    const lk = await voice.liveKit('ABCD23', RIDER, 'Alice');
    expect(lk).toMatchObject({ url: 'ws://127.0.0.1:7880', room: 'ride-ABCD23' });
    const info = voice.joinInfo('livekit', RIDER, lk);
    expect(info).toEqual({
      mode: 'livekit',
      available: ['livekit', 'mesh'],
      livekit: lk,
      iceServers: [{ urls: ['stun:stun.example:3478'] }],
    });
    expect(voice.joinInfo('mesh', RIDER, lk).livekit).toBeNull();
  });
});
