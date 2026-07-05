import { checkCompletionRange, ACCURACY_ALLOWANCE_CAP_M } from './completion.util';

const STOP = { lat: 0, lng: 0 };

describe('checkCompletionRange', () => {
  it('is in range well inside the radius', () => {
    // ~55.7m from the stop, radius 100
    const r = checkCompletionRange({ lat: 0, lng: 0.0005 }, STOP, 100);
    expect(r.inRange).toBe(true);
    expect(r.distanceM).toBeGreaterThan(50);
    expect(r.distanceM).toBeLessThan(60);
  });

  it('is in range exactly at the radius edge (<=)', () => {
    // ~100.2m raw → rounds to 100, radius 100 → still in
    const r = checkCompletionRange({ lat: 0, lng: 0.0009 }, STOP, 100);
    expect(r.distanceM).toBe(100);
    expect(r.inRange).toBe(true);
  });

  it('is out of range beyond radius + allowance', () => {
    // ~222.6m, radius 100, no accuracy
    const r = checkCompletionRange({ lat: 0, lng: 0.002 }, STOP, 100);
    expect(r.distanceM).toBeGreaterThan(200);
    expect(r.inRange).toBe(false);
  });

  it('GPS accuracy extends the radius', () => {
    // ~130m, radius 100, accuracy 40 → 100+40=140 ≥ 130 → in
    const r = checkCompletionRange({ lat: 0, lng: 0.00117 }, STOP, 100, 40);
    expect(r.inRange).toBe(true);
  });

  it('accuracy allowance is capped at 50m', () => {
    // ~160m, radius 100, accuracy 500 → capped to 100+50=150 < 160 → out
    const r = checkCompletionRange({ lat: 0, lng: 0.00144 }, STOP, 100, 500);
    expect(r.inRange).toBe(false);
    expect(ACCURACY_ALLOWANCE_CAP_M).toBe(50);
  });

  it('treats null accuracy as zero allowance', () => {
    const r = checkCompletionRange({ lat: 0, lng: 0.00117 }, STOP, 100, null);
    expect(r.inRange).toBe(false);
  });
});
