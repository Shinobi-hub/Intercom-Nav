import type { LatLng, Place } from '@intercom/shared';
import type { GeocoderName } from '../../config';

export interface PlaceQuery {
  q: string;
  /** Bias results towards this point. */
  near?: LatLng;
  limit: number;
}

export interface Geocoder {
  readonly name: GeocoderName;
  /** Rejects on provider failure; an empty array means "nothing found". */
  search(query: PlaceQuery): Promise<Place[]>;
}
