/**
 * Zod schemas for everything a client sends. The server parses every payload with these;
 * clients can use them to validate before sending.
 */
import { z } from 'zod';
import { LIMITS, RIDER_NAME_MAX, RIDER_SECRET_MAX, RIDER_SECRET_MIN } from './constants';
import { isValidRideCode, normalizeRideCode } from './ids';

export const latSchema = z.number().min(-90).max(90);
export const lngSchema = z.number().min(-180).max(180);
export const latLngSchema = z.object({ lat: latSchema, lng: lngSchema });

/** One GPS fix. Compact field names because this is the highest-volume message. */
export const locationFixSchema = z.object({
  lat: latSchema,
  lng: lngSchema,
  /** Horizontal accuracy, meters. */
  acc: z.number().min(0).max(100_000),
  /** Speed, m/s (null when unknown). */
  spd: z.number().min(0).max(150).nullable(),
  /** Heading, degrees clockwise from north (null when unknown or stationary). */
  hdg: z.number().min(0).max(360).nullable(),
  /** Altitude, meters (optional). */
  alt: z.number().min(-1_000).max(20_000).nullable().optional(),
  /** Client wall-clock time of the fix, ms since epoch. */
  t: z.number().int().positive(),
});

export const rideCodeSchema = z
  .string()
  .max(32)
  .transform(normalizeRideCode)
  .refine(isValidRideCode, { message: 'invalid ride code' });

export const riderIdSchema = z.uuid();
export const riderNameSchema = z.string().trim().min(1).max(RIDER_NAME_MAX);
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const micModeSchema = z.enum(['vox', 'open', 'off']);
export const voiceModeSchema = z.enum(['livekit', 'mesh']);
export const breakKindSchema = z.enum(['break', 'fuel', 'food', 'restroom']);

/** Identity a client presents on create/join. `secret` proves ownership of `id` on reconnect. */
export const riderAuthSchema = z.object({
  id: riderIdSchema,
  secret: z.string().min(RIDER_SECRET_MIN).max(RIDER_SECRET_MAX),
  name: riderNameSchema,
  color: colorSchema,
});

export const placeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  lat: latSchema,
  lng: lngSchema,
  address: z.string().trim().max(300).optional(),
});

// ---- client -> server payloads -------------------------------------------------------

export const rideCreateSchema = z.object({
  rider: riderAuthSchema,
  voiceMode: voiceModeSchema.optional(),
});

export const rideJoinSchema = z.object({
  code: rideCodeSchema,
  rider: riderAuthSchema,
});

export const emptySchema = z.object({}).strip();

export const riderUpdateSchema = z
  .object({
    name: riderNameSchema.optional(),
    color: colorSchema.optional(),
    micMode: micModeSchema.optional(),
  })
  .refine((p) => p.name !== undefined || p.color !== undefined || p.micMode !== undefined, {
    message: 'nothing to update',
  });

export const sosRaiseSchema = z.object({
  /** Client-generated UUID; raising the same id twice is a no-op (safe to retry). */
  id: z.uuid(),
  location: locationFixSchema.nullable(),
});

export const sosIdSchema = z.object({ id: z.uuid() });

export const breakRequestSchema = z.object({
  id: z.uuid(),
  kind: breakKindSchema,
  location: locationFixSchema.nullable(),
});

export const routeSetSchema = z.object({
  destination: placeSchema,
  waypoints: z.array(placeSchema).max(LIMITS.maxWaypoints).optional(),
  /** Route start. Defaults to the leader's last known location. */
  origin: latLngSchema.optional(),
});

export const placeSearchSchema = z.object({
  q: z.string().trim().min(LIMITS.placeQueryMin).max(LIMITS.placeQueryMax),
  near: latLngSchema.optional(),
  limit: z.number().int().min(1).max(LIMITS.placeResultsMax).optional(),
});

export const leaderTransferSchema = z.object({ to: riderIdSchema });

export const voiceSetModeSchema = z.object({ mode: voiceModeSchema });

export const rtcSignalDataSchema = z
  .object({
    description: z
      .object({
        type: z.enum(['offer', 'answer', 'pranswer', 'rollback']),
        sdp: z.string().max(LIMITS.sdpMaxChars).optional(),
      })
      .optional(),
    candidate: z
      .object({
        candidate: z.string().max(2_000),
        sdpMid: z.string().max(64).nullable().optional(),
        sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
        usernameFragment: z.string().max(256).nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .refine((d) => d.description !== undefined || d.candidate !== undefined, {
    message: 'signal needs a description or a candidate',
  });

export const rtcSignalSchema = z.object({
  to: riderIdSchema,
  data: rtcSignalDataSchema,
});

export const timeSyncSchema = z.object({ t0: z.number() });
