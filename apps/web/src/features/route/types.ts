export interface RouteProgress {
  /** Distance along the route still to go, meters. */
  remainingM: number;
  /** Estimated time to destination, seconds. */
  remainingS: number;
  /** Distance travelled along the route, meters. */
  alongM: number;
  totalM: number;
  /** Distance from the route line, meters. */
  offRouteM: number;
  offRoute: boolean;
}

export interface RiderGap {
  meters: number;
  /** true = that rider is ahead of me along the route; null when not measured along a route. */
  ahead: boolean | null;
  /** false when the distance is straight-line (no route, or someone is off route). */
  alongRoute: boolean;
}
