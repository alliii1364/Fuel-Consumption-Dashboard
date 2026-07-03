/**
 * Flag-routing unit tests for DashboardService.computeVehicle (via getSummary).
 * No database — all dependencies are jest.fn() mocks.
 *
 * Pins the invariant: FUEL_ROLLUP='1' → rollup.getConsumptionViaRollup called,
 * consumptionService.getConsumption NOT called, and vice-versa.
 */

import { DashboardService } from './dashboard.service';

// ---------------------------------------------------------------------------
// Stable sensor + consumption/rollup results
// ---------------------------------------------------------------------------
const SENSOR = {
  sensorId: 1, imei: '111111111111111', name: 'Tank', type: 'fuel',
  param: 'fuel', resultType: 'value', units: 'L', formula: '', calibration: [],
} as any;

const VEHICLE_ROW = {
  imei: '111111111111111', name: 'Test Truck', plate_number: 'ABC-123',
  dt_tracker: new Date(Date.now() - 1000 * 60), // 1 min ago → online
  fcr: '{}',
};

// ConsumptionResult shape (raw path)
const RAW_RESULT = {
  imei: '111111111111111',
  from: '2026-06-01T00:00:00.000Z',
  to: '2026-06-30T00:00:00.000Z',
  consumed: 50, refueled: 20, estimatedCost: 5000, unit: 'L',
  refuelEvents: 2, samples: 1000,
  refuels: [], drops: [],
  firstFuel: 100, lastFuel: 70, netDrop: 30,
};

// RangeMetrics shape (rollup path)
const ROLLUP_RESULT = {
  consumed: 50, refueled: 20, cost: 5000,
  refuels: [], firstFuel: 100, lastFuel: 70, netDrop: 30,
};

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------
function makeDashboardService(overrides: {
  getConsumption?: jest.Mock;
  getConsumptionViaRollup?: jest.Mock;
} = {}) {
  const getConsumption = overrides.getConsumption ?? jest.fn().mockResolvedValue(RAW_RESULT);
  const getConsumptionViaRollup = overrides.getConsumptionViaRollup ?? jest.fn().mockResolvedValue(ROLLUP_RESULT);

  const dataSource = {
    query: jest.fn().mockImplementation((sql: string) => {
      // Vehicle list query
      if (sql.includes('gs_user_objects')) return Promise.resolve([VEHICLE_ROW]);
      // FCR query (used in other methods)
      return Promise.resolve([{ fcr: '{}' }]);
    }),
  } as any;

  const config = {
    get: jest.fn().mockReturnValue(30), // STALE_THRESHOLD_MINUTES = 30
  } as any;

  const sensorResolver = {
    resolveFuelSensor: jest.fn().mockResolvedValue(SENSOR),
  } as any;

  const consumptionService = {
    getConsumption,
  } as any;

  const dynQuery = {
    getLatestRow: jest.fn().mockResolvedValue(null),
  } as any;

  const transform = {
    extractRawValue: jest.fn().mockReturnValue(null),
    transform: jest.fn().mockReturnValue({ value: null, method: 'raw' }),
  } as any;

  const thriftService = {} as any;

  const rollup = {
    getConsumptionViaRollup,
  } as any;

  const svc = new DashboardService(
    dataSource, config, sensorResolver, consumptionService,
    dynQuery, transform, thriftService, rollup,
  );

  return { svc, getConsumption, getConsumptionViaRollup };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('DashboardService — FUEL_ROLLUP flag routing', () => {
  const FROM = '2026-06-01T00:00:00.000Z';
  const TO   = '2026-06-30T00:00:00.000Z';
  const ORIG = process.env.FUEL_ROLLUP;

  afterEach(() => {
    if (ORIG === undefined) {
      delete process.env.FUEL_ROLLUP;
    } else {
      process.env.FUEL_ROLLUP = ORIG;
    }
    jest.clearAllMocks();
  });

  // T1: FUEL_ROLLUP=1 → rollup path called, raw path NOT called
  test('T1: FUEL_ROLLUP=1 → rollup.getConsumptionViaRollup called; consumptionService.getConsumption NOT called', async () => {
    process.env.FUEL_ROLLUP = '1';
    const { svc, getConsumption, getConsumptionViaRollup } = makeDashboardService();

    const summary = await svc.getSummary(1, FROM, TO);

    expect(getConsumptionViaRollup).toHaveBeenCalledTimes(1);
    expect(getConsumption).not.toHaveBeenCalled();
    expect(summary.vehicles).toHaveLength(1);
  });

  // T2: FUEL_ROLLUP=0 → raw path called, rollup path NOT called
  test('T2: FUEL_ROLLUP=0 → consumptionService.getConsumption called; rollup.getConsumptionViaRollup NOT called', async () => {
    process.env.FUEL_ROLLUP = '0';
    const { svc, getConsumption, getConsumptionViaRollup } = makeDashboardService();

    const summary = await svc.getSummary(1, FROM, TO);

    expect(getConsumption).toHaveBeenCalledTimes(1);
    expect(getConsumptionViaRollup).not.toHaveBeenCalled();
    expect(summary.vehicles).toHaveLength(1);
  });

  // T3: FUEL_ROLLUP unset (default) → raw path, rollup NOT called
  test('T3: FUEL_ROLLUP unset → raw path; rollup NOT called', async () => {
    delete process.env.FUEL_ROLLUP;
    const { svc, getConsumption, getConsumptionViaRollup } = makeDashboardService();

    await svc.getSummary(1, FROM, TO);

    expect(getConsumption).toHaveBeenCalledTimes(1);
    expect(getConsumptionViaRollup).not.toHaveBeenCalled();
  });

  // T4: Both branches produce VehicleSummary with same keys (shape preservation)
  test('T4: both branches produce VehicleSummary with identical keys', async () => {
    // Run raw path
    process.env.FUEL_ROLLUP = '0';
    const { svc: rawSvc } = makeDashboardService();
    const rawSummary = await rawSvc.getSummary(1, FROM, TO);

    // Run rollup path
    process.env.FUEL_ROLLUP = '1';
    const { svc: rollupSvc } = makeDashboardService();
    const rollupSummary = await rollupSvc.getSummary(1, FROM, TO);

    const rawKeys   = Object.keys(rawSummary.vehicles[0]).sort();
    const rollupKeys = Object.keys(rollupSummary.vehicles[0]).sort();

    expect(rollupKeys).toEqual(rawKeys);
  });

  // T5: Confirm the flag gate is not always one path (i.e., both values are tested)
  test('T5: flag correctly distinguishes =1 from =0 in same test run', async () => {
    process.env.FUEL_ROLLUP = '1';
    const { svc: s1, getConsumptionViaRollup: r1, getConsumption: c1 } = makeDashboardService();
    await s1.getSummary(1, FROM, TO);
    expect(r1).toHaveBeenCalled();
    expect(c1).not.toHaveBeenCalled();

    process.env.FUEL_ROLLUP = '0';
    const { svc: s2, getConsumptionViaRollup: r2, getConsumption: c2 } = makeDashboardService();
    await s2.getSummary(1, FROM, TO);
    expect(c2).toHaveBeenCalled();
    expect(r2).not.toHaveBeenCalled();
  });
});
