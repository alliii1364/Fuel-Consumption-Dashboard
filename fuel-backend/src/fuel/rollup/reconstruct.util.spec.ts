import { reconstructRange, DailyMetrics } from './reconstruct.util';

const day = (o: Partial<DailyMetrics>): DailyMetrics => ({
  day: o.day ?? '2026-06-01', consumed: o.consumed ?? 0, refueled: o.refueled ?? 0,
  netDrop: o.netDrop ?? null, firstFuel: o.firstFuel ?? null, lastFuel: o.lastFuel ?? null,
  cost: o.cost ?? null, refuels: o.refuels ?? [],
});

describe('reconstructRange', () => {
  it('sums refueled/cost and uses first/last boundaries for netDrop', () => {
    const r = reconstructRange([
      day({ day: '2026-06-01', consumed: 10, refueled: 5, firstFuel: 100, lastFuel: 95, cost: 50 }),
      day({ day: '2026-06-02', consumed: 8,  refueled: 0, firstFuel: 95,  lastFuel: 87, cost: 40 }),
    ]);
    expect(r.refueled).toBe(5);
    expect(r.cost).toBe(90);
    expect(r.firstFuel).toBe(100);
    expect(r.lastFuel).toBe(87);
    expect(r.netDrop).toBe(13);           // 100 - 87
  });
  it('consumed = max(0, netDrop + refueled) when boundaries exist', () => {
    const r = reconstructRange([
      day({ firstFuel: 100, lastFuel: 60, refueled: 20 }),
    ]);
    expect(r.consumed).toBe(60);          // max(0, 40 + 20)
  });
  it('falls back to summed daily consumed when a boundary is missing', () => {
    const r = reconstructRange([
      day({ consumed: 7, refueled: 0, firstFuel: null, lastFuel: null }),
      day({ consumed: 3, refueled: 0, firstFuel: 50, lastFuel: 40 }),
    ]);
    expect(r.netDrop).toBeNull();
    expect(r.consumed).toBe(10);          // 7 + 3
  });
  it('concatenates refuel events in order', () => {
    const a = { at: '2026-06-01T05:00:00Z', fuelBefore: 10, fuelAfter: 30, added: 20, unit: 'L' };
    const b = { at: '2026-06-02T06:00:00Z', fuelBefore: 20, fuelAfter: 50, added: 30, unit: 'L' };
    const r = reconstructRange([day({ refuels: [a] }), day({ refuels: [b] })]);
    expect(r.refuels).toEqual([a, b]);
  });
});
