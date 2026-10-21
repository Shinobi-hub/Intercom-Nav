import { bearingDeg, haversineM, placeSchema, type Place } from '@intercom/shared';
import { describe, expect, it, vi } from 'vitest';
import { fakeFetch, hangingFetch, jsonResponse, loadFixture } from '../../../test/support/fakeFetch';
import { ProviderError, USER_AGENT } from '../fetchJson';
import { createGeocoder } from './index';
import { MOCK_GEOCODER_CENTER, mockPlaces } from './mock';
import { createNominatimGeocoder, parseNominatimResults } from './nominatim';
import { createPhotonGeocoder, parsePhotonResults } from './photon';
import { createPlaceSearch, sanitizePlaces } from './placeSearch';
import type { Geocoder } from './types';

describe('photon', () => {
  it('sends the query, limit and location bias', async () => {
    const { fetch, requests } = fakeFetch(() => jsonResponse(loadFixture('photon-search.json')));
    const geocoder = createPhotonGeocoder({ baseUrl: 'https://photon.test', fetch, timeoutMs: 8000 });
    await geocoder.search({ q: 'shaniwar wada', near: { lat: 18.52, lng: 73.85 }, limit: 3 });
    const url = new URL(requests[0]!.url);
    expect(url.origin + url.pathname).toBe('https://photon.test/api/');
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'shaniwar wada', limit: '3', lat: '18.52', lon: '73.85' });
    expect(requests[0]!.headers['user-agent']).toBe(USER_AGENT);

    await geocoder.search({ q: 'pune', limit: 5 });
    expect(new URL(requests[1]!.url).searchParams.has('lat')).toBe(false);
  });

  it('parses a real response into named places with addresses', () => {
    const places = parsePhotonResults(loadFixture('photon-search.json'));
    expect(places[0]).toEqual({
      name: 'Shaniwar Wada',
      lat: 18.5193826,
      lng: 73.8553566,
      address: 'Shivaji Road, Pune, Maharashtra, India',
    });
    expect(places.map((p) => p.name)).toEqual(['Shaniwar Wada', 'Shaniwar Wada', 'Nana Wada']);
  });

  it('names unnamed features after their street or city and skips broken ones', () => {
    const places = parsePhotonResults({
      features: [
        { geometry: { coordinates: [73.8, 18.5] }, properties: { street: 'FC Road', housenumber: '12', city: 'Pune', country: 'India' } },
        { geometry: { coordinates: [73.9, 18.6] }, properties: { city: 'Pune', state: 'Maharashtra' } },
        { geometry: { coordinates: [1] }, properties: { name: 'broken' } },
        { geometry: { coordinates: [1, 2] }, properties: {} },
        'garbage',
      ],
    });
    expect(places).toEqual([
      { name: 'FC Road 12', lat: 18.5, lng: 73.8, address: 'Pune, India' },
      { name: 'Pune', lat: 18.6, lng: 73.9, address: 'Maharashtra' },
    ]);
    expect(() => parsePhotonResults({ message: 'oops' })).toThrow(ProviderError);
  });
});

describe('nominatim', () => {
  it('sends jsonv2 queries and biases with a viewbox', async () => {
    const { fetch, requests } = fakeFetch(() => jsonResponse(loadFixture('nominatim-search.json')));
    const geocoder = createNominatimGeocoder({ baseUrl: 'https://nominatim.test', fetch, timeoutMs: 8000 });
    await geocoder.search({ q: 'shaniwar wada', near: { lat: 18.52, lng: 73.85 }, limit: 4 });
    const url = new URL(requests[0]!.url);
    expect(url.origin + url.pathname).toBe('https://nominatim.test/search');
    expect(url.searchParams.get('q')).toBe('shaniwar wada');
    expect(url.searchParams.get('format')).toBe('jsonv2');
    expect(url.searchParams.get('limit')).toBe('4');
    expect(url.searchParams.get('viewbox')).toBe('73.35,19.02,74.35,18.02');
    expect(requests[0]!.headers['user-agent']).toBe(USER_AGENT);
  });

  it('parses a real response, splitting the name from the address', () => {
    const places = parseNominatimResults(loadFixture('nominatim-search.json'));
    expect(places[0]).toEqual({
      name: 'Shaniwar Wada',
      lat: 18.5193826,
      lng: 73.8553566,
      address: 'Shivaji Road, Kasba Peth, Pune, Pune City Subdistrict, Pune, Maharashtra, 411001, India',
    });
    expect(places).toHaveLength(2);
  });

  it('falls back to the first part of display_name and skips broken entries', () => {
    expect(
      parseNominatimResults([
        { lat: '1.5', lon: '2.5', name: '', display_name: 'Somewhere, Region, Country' },
        { lat: 'x', lon: '2', display_name: 'Broken' },
        { lat: '1', lon: '2' },
      ]),
    ).toEqual([{ name: 'Somewhere', lat: 1.5, lng: 2.5, address: 'Region, Country' }]);
    expect(() => parseNominatimResults({ error: 'nope' })).toThrow(ProviderError);
  });
});

describe('mock geocoder', () => {
  it('returns "<q> 1..3" at 1, 5 and 20 km north-east of `near`', () => {
    const near = { lat: 12.97, lng: 77.59 };
    const places = mockPlaces({ q: 'fuel', near, limit: 8 });
    expect(places.map((p) => p.name)).toEqual(['fuel 1', 'fuel 2', 'fuel 3']);
    [1000, 5000, 20000].forEach((meters, i) => {
      expect(haversineM(near, places[i]!)).toBeCloseTo(meters, -1);
      expect(bearingDeg(near, places[i]!)).toBeCloseTo(45, 0);
    });
  });

  it('centres on Pune without `near` and honours the limit', () => {
    const places = mockPlaces({ q: 'chai', limit: 2 });
    expect(places).toHaveLength(2);
    expect(haversineM(MOCK_GEOCODER_CENTER, places[0]!)).toBeCloseTo(1000, -1);
    expect(MOCK_GEOCODER_CENTER).toEqual({ lat: 18.5204, lng: 73.8567 });
  });

  it('is what GEOCODER=mock builds', async () => {
    const geocoder = createGeocoder({ provider: 'mock', photonUrl: 'x', nominatimUrl: 'y' }, fetch, 1000);
    expect(geocoder.name).toBe('mock');
    expect(await geocoder.search({ q: 'x', limit: 1 })).toEqual(mockPlaces({ q: 'x', limit: 1 }));
    expect(createGeocoder({ provider: 'photon', photonUrl: 'x', nominatimUrl: 'y' }, fetch, 1000).name).toBe('photon');
    expect(createGeocoder({ provider: 'nominatim', photonUrl: 'x', nominatimUrl: 'y' }, fetch, 1000).name).toBe('nominatim');
  });
});

describe('place search', () => {
  it('makes every result acceptable to route:set', () => {
    const raw: Place[] = [
      { name: `  ${'N'.repeat(250)}  `, lat: 1, lng: 2, address: 'A'.repeat(400) },
      { name: '   ', lat: 1, lng: 2 },
      { name: 'Out of range', lat: 91, lng: 2 },
      { name: 'Twice', lat: 3, lng: 4, address: 'Same' },
      { name: 'twice', lat: 3.001, lng: 4, address: 'same' },
      { name: 'Blank address', lat: 5, lng: 6, address: '  ' },
    ];
    const clean = sanitizePlaces(raw);
    expect(clean.map((p) => p.name)).toEqual(['N'.repeat(200), 'Twice', 'Blank address']);
    expect(clean[0]!.address).toHaveLength(300);
    expect(clean[2]).toEqual({ name: 'Blank address', lat: 5, lng: 6 });
    for (const p of clean) expect(placeSchema.safeParse(p).success).toBe(true);
  });

  it('caches by query, rounded bias and limit', async () => {
    let t = 0;
    const search = vi.fn(async (q: { q: string; limit: number }) => mockPlaces(q));
    const geocoder: Geocoder = { name: 'mock', search };
    const places = createPlaceSearch({ geocoder, now: () => t });
    const near = { lat: 18.52, lng: 73.85 };
    const first = await places.search({ q: 'Fuel', near, limit: 3 });
    expect(await places.search({ q: 'fuel', near: { lat: 18.521, lng: 73.851 }, limit: 3 })).toEqual(first);
    expect(search).toHaveBeenCalledTimes(1);
    await places.search({ q: 'fuel', near, limit: 2 });
    await places.search({ q: 'fuel', limit: 3 });
    expect(search).toHaveBeenCalledTimes(3);
    t += 31 * 60_000;
    await places.search({ q: 'fuel', near, limit: 3 });
    expect(search).toHaveBeenCalledTimes(4);
    // Callers get copies, so they can't corrupt the cache.
    const cached = await places.search({ q: 'fuel', near, limit: 3 });
    cached[0]!.name = 'mutated';
    expect((await places.search({ q: 'fuel', near, limit: 3 }))[0]!.name).toBe('fuel 1');
    expect(search).toHaveBeenCalledTimes(4);
  });

  it('trims results to the limit and propagates (without caching) failures', async () => {
    let calls = 0;
    const flaky: Geocoder = {
      name: 'photon',
      search: async (q) => {
        calls++;
        if (calls === 1) throw new ProviderError('HTTP 502', 502);
        return [...mockPlaces({ ...q, limit: 3 }), ...mockPlaces({ ...q, q: `${q.q}!`, limit: 3 })];
      },
    };
    const places = createPlaceSearch({ geocoder: flaky, now: () => 0 });
    await expect(places.search({ q: 'x', limit: 4 })).rejects.toThrow(ProviderError);
    expect(await places.search({ q: 'x', limit: 4 })).toHaveLength(4);
  });

  it('surfaces provider timeouts as errors', async () => {
    const geocoder = createPhotonGeocoder({ baseUrl: 'https://photon.test', fetch: hangingFetch, timeoutMs: 20 });
    await expect(createPlaceSearch({ geocoder, now: () => 0 }).search({ q: 'x', limit: 1 })).rejects.toThrow(/timed out/);
  });
});
