/**
 * Pure unit tests for FuelRollupCron.
 * No real DataSource — all dependencies are jest.fn() mocks.
 */
import { FuelRollupCron } from './fuel-rollup.cron';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockDs(vehicles: any[] = []) {
  return { query: jest.fn().mockResolvedValue(vehicles) } as any;
}

function makeMockRollup() {
  return { computeAndStoreDay: jest.fn().mockResolvedValue(undefined) } as any;
}

function makeMockSensors(sensorOrThrow?: any) {
  const fn = jest.fn();
  if (sensorOrThrow instanceof Error) {
    fn.mockRejectedValue(sensorOrThrow);
  } else {
    fn.mockResolvedValue(sensorOrThrow ?? { sensorId: 1, imei: 'v1', name: 'Tank', type: 'fuel', param: 'fuel', resultType: 'value', units: 'L', formula: '', calibration: [] });
  }
  return { resolveFuelSensor: fn } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FuelRollupCron', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.FUEL_ROLLUP;
    // Use fake timers so setTimeout(200ms) between vehicles doesn't actually wait
    jest.useFakeTimers();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FUEL_ROLLUP;
    } else {
      process.env.FUEL_ROLLUP = originalEnv;
    }
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Flag off — roll() returns immediately without touching the DB
  // -------------------------------------------------------------------------
  it('1. flag off: roll() is a no-op when FUEL_ROLLUP !== "1"', async () => {
    delete process.env.FUEL_ROLLUP;

    const ds = makeMockDs([{ imei: 'v1', fcr: '{}' }]);
    const rollup = makeMockRollup();
    const sensors = makeMockSensors();

    const cron = new FuelRollupCron(ds, rollup, sensors);
    await cron.roll();

    expect(ds.query).not.toHaveBeenCalled();
    expect(rollup.computeAndStoreDay).not.toHaveBeenCalled();
  });

  it('1b. flag off with wrong value: roll() is a no-op when FUEL_ROLLUP="0"', async () => {
    process.env.FUEL_ROLLUP = '0';

    const ds = makeMockDs([{ imei: 'v1', fcr: '{}' }]);
    const rollup = makeMockRollup();
    const sensors = makeMockSensors();

    const cron = new FuelRollupCron(ds, rollup, sensors);
    await cron.roll();

    expect(ds.query).not.toHaveBeenCalled();
    expect(rollup.computeAndStoreDay).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. Flag on — computeAndStoreDay called for each vehicle × day
  // -------------------------------------------------------------------------
  it('2. flag on: computeAndStoreDay called once per vehicle × day', async () => {
    process.env.FUEL_ROLLUP = '1';

    const vehicles = [
      { imei: 'v1', fcr: '{"consumption":10}' },
      { imei: 'v2', fcr: '{"consumption":8}' },
    ];
    const ds = makeMockDs(vehicles);
    const rollup = makeMockRollup();
    const sensor1 = { sensorId: 1, imei: 'v1', name: 'Tank', type: 'fuel', param: 'fuel', resultType: 'value', units: 'L', formula: '', calibration: [] };
    const sensor2 = { sensorId: 2, imei: 'v2', name: 'Tank', type: 'fuel', param: 'fuel', resultType: 'value', units: 'L', formula: '', calibration: [] };
    const sensors = { resolveFuelSensor: jest.fn().mockResolvedValueOnce(sensor1).mockResolvedValueOnce(sensor2) } as any;

    const cron = new FuelRollupCron(ds, rollup, sensors);

    // Run roll() — advance fake timers to resolve all setTimeouts
    const rollPromise = cron.roll();
    // Drain microtasks and advance fake timers repeatedly until done
    await jest.runAllTimersAsync();
    await rollPromise;

    expect(ds.query).toHaveBeenCalledTimes(1);
    expect(sensors.resolveFuelSensor).toHaveBeenCalledWith('v1');
    expect(sensors.resolveFuelSensor).toHaveBeenCalledWith('v2');

    // computeAndStoreDay must have been called for each vehicle × day pair
    // karachiDayStrs over ~2 days = 1 or 2 full days depending on the moment;
    // we just assert it was called at least once per vehicle.
    const calls = rollup.computeAndStoreDay.mock.calls;
    const calledImeis = calls.map((c: any[]) => c[0]);
    expect(calledImeis).toContain('v1');
    expect(calledImeis).toContain('v2');

    // FCR is forwarded correctly
    const v1Calls = calls.filter((c: any[]) => c[0] === 'v1');
    expect(v1Calls.every((c: any[]) => c[3] === vehicles[0].fcr)).toBe(true);
    const v2Calls = calls.filter((c: any[]) => c[0] === 'v2');
    expect(v2Calls.every((c: any[]) => c[3] === vehicles[1].fcr)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. One sensor resolution throws — that vehicle skipped, other still processed
  // -------------------------------------------------------------------------
  it('3. sensor resolve throws: bad vehicle skipped, good vehicle still processed', async () => {
    process.env.FUEL_ROLLUP = '1';

    const vehicles = [
      { imei: 'bad', fcr: '' },
      { imei: 'good', fcr: '{}' },
    ];
    const ds = makeMockDs(vehicles);
    const rollup = makeMockRollup();
    const goodSensor = { sensorId: 5, imei: 'good', name: 'Tank', type: 'fuel', param: 'fuel', resultType: 'value', units: 'L', formula: '', calibration: [] };
    const sensors = {
      resolveFuelSensor: jest.fn()
        .mockRejectedValueOnce(new Error('no fuel sensor'))
        .mockResolvedValueOnce(goodSensor),
    } as any;

    const cron = new FuelRollupCron(ds, rollup, sensors);

    const rollPromise = cron.roll();
    await jest.runAllTimersAsync();
    await rollPromise;

    // 'bad' vehicle had sensor error → computeAndStoreDay NOT called for it
    const calls = rollup.computeAndStoreDay.mock.calls;
    const calledImeis = calls.map((c: any[]) => c[0]);
    expect(calledImeis).not.toContain('bad');
    // 'good' vehicle processed normally
    expect(calledImeis).toContain('good');
  });
});
