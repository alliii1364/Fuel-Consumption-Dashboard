import { DeviationService } from './deviation.service';
import { RouteStop } from './route.repository';
import { TrailPoint } from './deviation.service';
import { LatLng } from './geo.util';

// A 4-vertex straight line heading east; stop fractions differ along it.
const GEOM: LatLng[] = [
  { lat: 0, lng: 0 },
  { lat: 0, lng: 0.01 },
  { lat: 0, lng: 0.02 },
  { lat: 0, lng: 0.03 },
];

function stop(seq: number, lat: number, lng: number, radiusM = 50): RouteStop {
  return { seq, name: `Stop ${seq}`, lat, lng, type: 'bin', radiusM };
}

function pt(ms: number, lat: number, lng: number, speed: number): TrailPoint {
  return { ts: new Date(ms), lat, lng, speed };
}

const svc = new DeviationService();
const route = (stops: RouteStop[]) => ({ geometry: GEOM, stops, corridorBufferM: 100 });
const statusOf = (a: ReturnType<DeviationService['analyze']>, seq: number) =>
  a.stopStatuses.find((s) => s.seq === seq)?.status;

describe('DeviationService stop classification', () => {
  it('marks a stop STOPPED when dwelled slow and long within radius', () => {
    const s = stop(1, 0, 0.01);
    // 3 min at the bin, speed ~0
    const trail = [
      pt(0, 0, 0.01, 0),
      pt(90_000, 0, 0.01, 1),
      pt(180_000, 0, 0.01, 0),
    ];
    const a = svc.analyze(route([s]), trail, trail, 'tracker');
    expect(statusOf(a, 1)).toBe('stopped');
    const ss = a.stopStatuses.find((x) => x.seq === 1)!;
    expect(ss.dwellS).toBe(180);
    expect(ss.arrivedAt).toBe(new Date(0).toISOString());
  });

  it('marks a stop SKIPPED when it drove through the radius without stopping', () => {
    const s = stop(1, 0, 0.01);
    // two quick fixes, both moving fast, short span
    const trail = [pt(0, 0, 0.0099, 30), pt(20_000, 0, 0.0101, 32)];
    const a = svc.analyze(route([s]), trail, trail, 'tracker');
    expect(statusOf(a, 1)).toBe('skipped');
  });

  it('marks a stop NOT_REACHED when never in radius and progress is past it', () => {
    const s = stop(1, 0, 0.01); // early stop (fraction ~0.33)
    // driver is near the END of the route, never went to the bin
    const trail = [pt(0, 0, 0.03, 40)];
    const a = svc.analyze(route([s]), trail, trail, 'tracker');
    expect(statusOf(a, 1)).toBe('not_reached');
  });

  it('marks a stop PENDING when never in radius and still ahead on an active job', () => {
    const s = stop(1, 0, 0.03); // late stop (fraction ~1.0)
    // driver near the START, hasn't reached the far bin yet
    const trail = [pt(0, 0, 0.0, 40)];
    const a = svc.analyze(route([s]), trail, trail, 'tracker');
    expect(statusOf(a, 1)).toBe('pending');
  });

  it('sparse fallback: a single near-zero-speed in-radius fix counts as STOPPED', () => {
    const s = stop(1, 0, 0.01);
    const trail = [pt(0, 0, 0.01, 1)]; // one fix, ~parked
    const a = svc.analyze(route([s]), trail, trail, 'tracker');
    expect(statusOf(a, 1)).toBe('stopped');
  });

  it('a single fast in-radius fix is SKIPPED, not stopped', () => {
    const s = stop(1, 0, 0.01);
    const trail = [pt(0, 0, 0.01, 30)];
    const a = svc.analyze(route([s]), trail, trail, 'tracker');
    expect(statusOf(a, 1)).toBe('skipped');
  });

  it('when the job has ended, a never-reached stop is NOT_REACHED (not pending)', () => {
    const s = stop(1, 0, 0.03); // far ahead by progress
    const trail = [pt(0, 0, 0.0, 0)];
    const a = svc.analyze(route([s]), trail, trail, 'tracker', true);
    expect(statusOf(a, 1)).toBe('not_reached');
  });

  it('still derives visitedStopSeqs/missedStopSeqs by proximity (unchanged)', () => {
    const visited = stop(1, 0, 0.01);
    const missed = stop(2, 0, 0.03);
    const trail = [pt(0, 0, 0.01, 30)]; // in radius of stop 1 only, moving
    const a = svc.analyze(route([visited, missed]), trail, trail, 'tracker');
    // proximity => stop 1 visited even though it was only "skipped" by dwell
    expect(a.visitedStopSeqs).toContain(1);
    expect(a.missedStopSeqs).toContain(2);
    expect(statusOf(a, 1)).toBe('skipped');
  });

  it('does not inflate dwell when the vehicle revisits the bin much later', () => {
    const s = stop(1, 0, 0.01);
    // Visit A: parked ~150s at the bin.
    const A = [pt(0, 0, 0.01, 0), pt(90_000, 0, 0.01, 0), pt(150_000, 0, 0.01, 0)];
    // ~2h gap, then Visit B: parked ~150s again.
    const B = [pt(7_350_000, 0, 0.01, 0), pt(7_440_000, 0, 0.01, 0), pt(7_500_000, 0, 0.01, 0)];
    const trail = [...A, ...B];
    const a = svc.analyze(route([s]), trail, trail, 'tracker');
    expect(statusOf(a, 1)).toBe('stopped');
    const ss = a.stopStatuses.find((x) => x.seq === 1)!;
    // dwell reflects a single ~150s visit, NOT the ~2h first-to-last span (7500s).
    expect(ss.dwellS).toBeGreaterThanOrEqual(150);
    expect(ss.dwellS).toBeLessThanOrEqual(200);
  });
});
