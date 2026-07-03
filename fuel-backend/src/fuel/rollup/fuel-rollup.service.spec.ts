/**
 * Pure unit tests for FuelRollupService.
 * No database, no DataSource — all dependencies are jest.fn() mocks.
 */
import { FuelRollupService } from './fuel-rollup.service';
import { dayUtcRange } from './karachi-day.util';
import { reconstructRange } from './reconstruct.util';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConsumptionService(getConsumptionImpl?: jest.Mock) {
  return {
    getConsumption: getConsumptionImpl ?? jest.fn(),
  } as any;
}

function makeRepository(getDaysImpl?: jest.Mock, upsertDayImpl?: jest.Mock) {
  return {
    getDays: getDaysImpl ?? jest.fn().mockResolvedValue([]),
    upsertDay: upsertDayImpl ?? jest.fn().mockResolvedValue(undefined),
    hasDay: jest.fn().mockResolvedValue(false),
    deleteVehicle: jest.fn().mockResolvedValue(undefined),
    deleteOrphans: jest.fn().mockResolvedValue(0),
  } as any;
}

const IMEI = '123456789012345';
const FCR = '{}';
const SENSOR = { sensorId: 1, imei: IMEI, name: 'Tank', type: 'fuel', param: 'fuel', resultType: 'value', units: 'L', formula: '', calibration: [] } as any;

// A Karachi-day-aligned range: 2026-06-01 in Karachi = 2026-05-31T19:00Z → 2026-06-01T19:00Z
const DAY1 = '2026-06-01';
const DAY2 = '2026-06-02';
const { start: FROM } = dayUtcRange(DAY1); // 2026-05-31T19:00Z
const { end: TO } = dayUtcRange(DAY2);     // 2026-06-02T19:00Z

const ROW1 = { day: DAY1, consumed: 10, refueled: 5, netDrop: 5, firstFuel: 100, lastFuel: 95, cost: 1000, refuels: [] };
const ROW2 = { day: DAY2, consumed: 8,  refueled: 0, netDrop: 8, firstFuel: 95,  lastFuel: 87, cost: 800,  refuels: [] };

// ---------------------------------------------------------------------------
// 1. All days cached — getDays called once, getConsumption NOT called
// ---------------------------------------------------------------------------
describe('FuelRollupService', () => {
  test('1. all-cached: uses getDays only, returns reconstructRange(rows)', async () => {
    const getDays = jest.fn().mockResolvedValue([ROW1, ROW2]);
    const getConsumption = jest.fn();
    const svc = new FuelRollupService(makeConsumptionService(getConsumption), makeRepository(getDays));

    const result = await svc.getConsumptionViaRollup(IMEI, FROM, TO, SENSOR, FCR);

    expect(getDays).toHaveBeenCalledTimes(1);
    expect(getConsumption).not.toHaveBeenCalled();
    const expected = reconstructRange([ROW1, ROW2]);
    expect(result).toEqual(expected);
  });

  // ---------------------------------------------------------------------------
  // 2. Compute-on-miss: missing full day → getConsumption + upsertDay, then re-read + reconstruct
  // ---------------------------------------------------------------------------
  test('2. compute-on-miss: missing day triggers getConsumption + upsertDay, then re-reads', async () => {
    const consumptionResult = {
      consumed: 8, refueled: 0, estimatedCost: 800, unit: 'L',
      refuels: [], drops: [], firstFuel: 95, lastFuel: 87, netDrop: 8, samples: 120,
    };
    // First getDays call returns only ROW1 (DAY2 missing); second returns both
    const getDays = jest.fn()
      .mockResolvedValueOnce([ROW1])
      .mockResolvedValueOnce([ROW1, ROW2]);
    const upsertDay = jest.fn().mockResolvedValue(undefined);
    const getConsumption = jest.fn().mockResolvedValue(consumptionResult);

    const svc = new FuelRollupService(makeConsumptionService(getConsumption), makeRepository(getDays, upsertDay));

    const result = await svc.getConsumptionViaRollup(IMEI, FROM, TO, SENSOR, FCR);

    // getDays called twice: initial check + re-read after compute-on-miss
    expect(getDays).toHaveBeenCalledTimes(2);
    // getConsumption called for the missing DAY2
    const { start: d2Start, end: d2End } = dayUtcRange(DAY2);
    expect(getConsumption).toHaveBeenCalledWith(IMEI, d2Start, d2End, SENSOR, FCR);
    // upsertDay was called
    expect(upsertDay).toHaveBeenCalled();
    // result is reconstructed from both rows
    const expected = reconstructRange([ROW1, ROW2]);
    expect(result).toEqual(expected);
  });

  // ---------------------------------------------------------------------------
  // 3. computeAndStoreDay: getConsumption throws → upsert zero row
  // ---------------------------------------------------------------------------
  test('3. computeAndStoreDay: rejected getConsumption → upserts zero row', async () => {
    const getConsumption = jest.fn().mockRejectedValue(new Error('no data'));
    const upsertDay = jest.fn().mockResolvedValue(undefined);
    const svc = new FuelRollupService(makeConsumptionService(getConsumption), makeRepository(undefined, upsertDay));

    await svc.computeAndStoreDay(IMEI, SENSOR, DAY1, FCR);

    expect(upsertDay).toHaveBeenCalledTimes(1);
    const call = upsertDay.mock.calls[0][2]; // third arg is the metrics object
    expect(call.day).toBe(DAY1);
    expect(call.consumed).toBe(0);
    expect(call.refueled).toBe(0);
    expect(call.netDrop).toBeNull();
    expect(call.firstFuel).toBeNull();
    expect(call.lastFuel).toBeNull();
    expect(call.samples).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 4. computeAndStoreDay: real ConsumptionResult → correct consumed formula
  // ---------------------------------------------------------------------------
  test('4. computeAndStoreDay: real result → consumed = max(0, netDrop + refueled)', async () => {
    const consumptionResult = {
      consumed: 999, // should NOT be used when netDrop != null
      refueled: 20, estimatedCost: 2000, unit: 'L',
      refuels: [{ at: '2026-06-01T06:00:00.000Z', fuelBefore: 80, fuelAfter: 100, added: 20, unit: 'L' }],
      drops: [], firstFuel: 110, lastFuel: 100, netDrop: 10, samples: 200,
    };
    const getConsumption = jest.fn().mockResolvedValue(consumptionResult);
    const upsertDay = jest.fn().mockResolvedValue(undefined);
    const svc = new FuelRollupService(makeConsumptionService(getConsumption), makeRepository(undefined, upsertDay));

    await svc.computeAndStoreDay(IMEI, SENSOR, DAY1, FCR);

    expect(upsertDay).toHaveBeenCalledTimes(1);
    const m = upsertDay.mock.calls[0][2];
    // consumed = max(0, 10 + 20) = 30
    expect(m.consumed).toBe(30);
    expect(m.refueled).toBe(20);
    expect(m.netDrop).toBe(10);
    expect(m.firstFuel).toBe(110);
    expect(m.lastFuel).toBe(100);
    expect(m.cost).toBe(2000);
    expect(m.refuels).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 5. Non-aligned range → edge days fetched via getConsumption with partial windows
  // ---------------------------------------------------------------------------
  test('5. non-aligned range → getConsumption called with partial-edge from/to', async () => {
    // from is mid-day (not aligned), to is mid-day (not aligned)
    // Use a mid-day time: 2026-06-01T10:00:00Z (5am Karachi = not midnight)
    const midFrom = new Date('2026-06-01T10:00:00.000Z'); // not aligned
    const midTo   = new Date('2026-06-02T10:00:00.000Z'); // not aligned

    // karachiDayStrs(midFrom, midTo): the only full day inside would be...
    // midFrom = 2026-06-01T10:00Z → Karachi = 2026-06-01T15:00 → not aligned
    // next midnight boundary: 2026-06-01T19:00Z (start of 2026-06-02 in Karachi)
    // midTo = 2026-06-02T10:00Z → Karachi = 2026-06-02T15:00 → not aligned
    // full day 2026-06-02 would need end = 2026-06-02T19:00Z but midTo < that → no full days
    // So fullDays = []
    // Leading edge: from=midFrom to firstFullStart=midTo (since no full days, firstFullStart=midTo → from < midTo, so edge called)
    // Actually with no full days: firstFullStart = to = midTo; from < midTo → edge call
    // Trailing edge: no full days: lastFullEnd = from = midFrom; to > midFrom → edge call

    // Let's instead use a range that contains exactly one full day with non-aligned edges
    // from = 2026-05-31T21:00Z (not aligned; Karachi = 2026-06-01T02:00)
    // to   = 2026-06-01T21:00Z (not aligned; Karachi = 2026-06-02T02:00)
    // full day inside: 2026-06-01 → start=2026-05-31T19:00Z, end=2026-06-01T19:00Z
    // since from(21:00Z) > start(19:00Z), no leading edge?
    // Actually karachiDayStrs: firstFull = next midnight after from if not aligned
    // from = 2026-05-31T21:00Z → not aligned → next midnight = 2026-06-01T19:00Z
    // to = 2026-06-01T21:00Z → s+24h = 2026-06-02T19:00Z > to(21:00Z) → no full days
    // So fullDays = []

    // Let's use: from = 2026-05-31T21:00Z (not aligned), to = 2026-06-02T21:00Z (not aligned)
    // from not aligned → firstFull = next midnight = 2026-06-01T19:00Z
    // can we fit 2026-06-01? start=2026-05-31T19:00Z, end=2026-06-01T19:00Z — but firstFull=2026-06-01T19:00Z, so s=2026-06-01T19:00Z, s+24h=2026-06-02T19:00Z <= to(2026-06-02T21:00Z) → YES, day 2026-06-02
    // Actually: firstFull = dayUtcRange(toKarachiDayStr(from + 24h)).start
    // from = 2026-05-31T21:00Z + 24h = 2026-06-01T21:00Z → Karachi day = 2026-06-02 → start = 2026-06-01T19:00Z
    // s=2026-06-01T19:00Z, s+24h=2026-06-02T19:00Z <= to(2026-06-02T21:00Z) → push '2026-06-02'
    // fullDays = ['2026-06-02']
    // leading partial: from(21:00Z) < firstFullStart(2026-06-01T19:00Z)? No: 2026-05-31T21:00Z < 2026-06-01T19:00Z → YES → edge(from, firstFullStart)
    // trailing partial: to(2026-06-02T21:00Z) > lastFullEnd(2026-06-02T19:00Z) → YES → edge(lastFullEnd, to)

    const partialFrom = new Date('2026-05-31T21:00:00.000Z'); // not aligned
    const partialTo   = new Date('2026-06-02T21:00:00.000Z'); // not aligned
    const fullDay = '2026-06-02';
    const fullDayRow = { day: fullDay, consumed: 5, refueled: 0, netDrop: 5, firstFuel: 90, lastFuel: 85, cost: 500, refuels: [] };

    const edgeResult = {
      consumed: 2, refueled: 0, estimatedCost: null, unit: 'L',
      refuels: [], drops: [], firstFuel: 92, lastFuel: 90, netDrop: 2, samples: 30,
    };

    const getDays = jest.fn().mockResolvedValue([fullDayRow]);
    const getConsumption = jest.fn().mockResolvedValue(edgeResult);

    const svc = new FuelRollupService(makeConsumptionService(getConsumption), makeRepository(getDays));

    await svc.getConsumptionViaRollup(IMEI, partialFrom, partialTo, SENSOR, FCR);

    // getConsumption must be called for the leading edge partial window
    const { start: fullDayStart } = dayUtcRange(fullDay); // 2026-06-01T19:00Z
    const { end: fullDayEnd }   = dayUtcRange(fullDay);   // 2026-06-02T19:00Z
    expect(getConsumption).toHaveBeenCalledWith(IMEI, partialFrom, fullDayStart, SENSOR, FCR);
    // and for the trailing edge
    expect(getConsumption).toHaveBeenCalledWith(IMEI, fullDayEnd, partialTo, SENSOR, FCR);
  });
});
