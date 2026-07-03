import { RefuelEvent } from '../services/fuel-consumption.service';

export interface DailyMetrics {
  day: string;
  consumed: number;
  refueled: number;
  netDrop: number | null;
  firstFuel: number | null;
  lastFuel: number | null;
  cost: number | null;
  refuels: RefuelEvent[];
}
export type RangeMetrics = Omit<DailyMetrics, 'day'>;

/** Combine ordered per-day metrics into range metrics, mirroring the current
 *  summary math: mass-balance from the range's first/last boundary fuel when
 *  available, else the summed daily drop totals. */
export function reconstructRange(parts: DailyMetrics[]): RangeMetrics {
  const refueled = parts.reduce((a, p) => a + p.refueled, 0);
  const costParts = parts.map((p) => p.cost).filter((c): c is number => c !== null);
  const cost = costParts.length ? costParts.reduce((a, c) => a + c, 0) : null;
  const refuels = parts.flatMap((p) => p.refuels);

  const firstFuel = parts.length ? parts[0].firstFuel : null;
  const lastFuel = parts.length ? parts[parts.length - 1].lastFuel : null;

  let netDrop: number | null = null;
  let consumed: number;
  if (firstFuel !== null && lastFuel !== null) {
    netDrop = firstFuel - lastFuel;
    consumed = Math.max(0, netDrop + refueled);
  } else {
    consumed = parts.reduce((a, p) => a + p.consumed, 0);
  }
  return { consumed, refueled, netDrop, firstFuel, lastFuel, cost, refuels };
}
