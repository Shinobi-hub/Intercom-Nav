import type { Err } from '@intercom/shared';

/** Rider-facing text for a failed route or search request. */
export function describeRouteError(err: Err, fallback: string): string {
  switch (err.error) {
    case 'not_leader':
      return 'Only the ride leader can change the destination.';
    case 'no_origin':
      return 'Waiting for your GPS position. Try again in a moment.';
    case 'route_failed':
      return "Couldn't find a route there. Try another place.";
    case 'geocode_failed':
      return "Place search isn't available right now.";
    case 'rate_limited':
      return 'Too many requests. Wait a moment and try again.';
    case 'unavailable':
      return "That isn't available right now.";
    case 'invalid_payload':
      return fallback;
    default:
      return err.message || fallback;
  }
}
