import { LatLng, haversineMeters } from './geo.util';

/** Cap on how much a poor GPS fix may extend the bin radius. */
export const ACCURACY_ALLOWANCE_CAP_M = 50;

export interface CompletionCheck {
  /** Driver → bin distance, whole metres. */
  distanceM: number;
  /** True when within radius_m + min(accuracy, cap). */
  inRange: boolean;
}

/**
 * The bin-completion verification rule: the driver counts as "at the bin"
 * when their distance is within the stop's geofence radius, extended by the
 * device-reported GPS accuracy (capped so a wildly-inaccurate fix can't pass).
 */
export function checkCompletionRange(
  driver: LatLng,
  stop: LatLng,
  radiusM: number,
  accuracyM?: number | null,
): CompletionCheck {
  const distanceM = Math.round(haversineMeters(driver, stop));
  const allowance = Math.min(accuracyM ?? 0, ACCURACY_ALLOWANCE_CAP_M);
  return { distanceM, inRange: distanceM <= radiusM + allowance };
}
