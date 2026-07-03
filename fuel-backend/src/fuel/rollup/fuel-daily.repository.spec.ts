import { rowToDaily } from './fuel-daily.repository';

describe('rowToDaily', () => {
  it('maps a DB row (JSON refuel_events string) to DailyMetrics', () => {
    const m = rowToDaily({
      day: '2026-06-01', consumed: 10, refueled: 5, net_drop: 13,
      first_fuel: 100, last_fuel: 87, cost: 90,
      refuel_events: '[{"at":"2026-06-01T05:00:00Z","fuelBefore":10,"fuelAfter":30,"added":20,"unit":"L"}]',
    } as any);
    expect(m.day).toBe('2026-06-01');
    expect(m.netDrop).toBe(13);
    expect(m.refuels).toHaveLength(1);
    expect(m.refuels[0].added).toBe(20);
  });
  it('handles null refuel_events', () => {
    const m = rowToDaily({ day: '2026-06-02', consumed: 0, refueled: 0, net_drop: null,
      first_fuel: null, last_fuel: null, cost: null, refuel_events: null } as any);
    expect(m.refuels).toEqual([]);
    expect(m.netDrop).toBeNull();
  });
});
