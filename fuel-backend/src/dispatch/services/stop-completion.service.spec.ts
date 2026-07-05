import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { StopCompletionService } from './stop-completion.service';
import { StopCompletion } from './stop-completion.repository';

// --- fakes -----------------------------------------------------------------
function makeFakes(opts: {
  status?: string;
  stops?: Array<{ stopId: number; seq: number; name: string; lat: number; lng: number; radiusM: number }>;
  existing?: StopCompletion[];
}) {
  const stops = opts.stops ?? [
    { stopId: 11, seq: 1, name: 'Bin 1', lat: 0, lng: 0, radiusM: 100 },
    { stopId: 12, seq: 2, name: 'Bin 2', lat: 0, lng: 0.01, radiusM: 100 },
  ];
  const store: StopCompletion[] = [...(opts.existing ?? [])];
  const events: any[] = [];
  const statusCalls: any[] = [];

  const assignments = {
    getForDriver: jest.fn(async () => ({
      assignmentId: 5,
      userId: 1,
      routeId: 7,
      driverId: 3,
      status: opts.status ?? 'en_route',
    })),
    addEvent: jest.fn(async (_id: number, e: any) => { events.push(e); }),
    setStatus: jest.fn(async (...args: any[]) => { statusCalls.push(args); }),
  };
  const routes = { get: jest.fn(async () => ({ stops })) };
  let nextId = 100;
  const completions = {
    getForStop: jest.fn(async (_a: number, stopId: number) =>
      store.find((c) => c.stopId === stopId) ?? null),
    add: jest.fn(async (c: any) => {
      store.push({ ...c, id: ++nextId, createdAt: new Date() });
      return nextId;
    }),
    listForAssignment: jest.fn(async () => [...store]),
  };
  const svc = new StopCompletionService(assignments as any, routes as any, completions as any);
  return { svc, assignments, routes, completions, events, statusCalls, store };
}

const AT_BIN_1 = { lat: 0, lng: 0.0001, photoPath: 'completions/x.jpg' }; // ~11m away

describe('StopCompletionService.complete', () => {
  it('records an in-range completion and logs a stop_completed event', async () => {
    const f = makeFakes({});
    const r = await f.svc.complete(3, 5, 11, AT_BIN_1);
    expect(r.completion.inRange).toBe(true);
    expect(r.completion.stopId).toBe(11);
    expect(r.jobCompleted).toBe(false);
    expect(f.events).toHaveLength(1);
    expect(f.events[0].type).toBe('stop_completed');
    expect(f.events[0].actor).toBe('driver');
    expect(f.events[0].note).not.toContain('out of range');
    expect(f.statusCalls).toHaveLength(0); // one bin left
  });

  it('accepts but flags an out-of-range completion', async () => {
    const f = makeFakes({});
    // ~1113m from Bin 1
    const r = await f.svc.complete(3, 5, 11, { lat: 0, lng: 0.01, photoPath: 'completions/x.jpg' });
    expect(r.completion.inRange).toBe(false);
    expect(f.events[0].note).toContain('out of range');
    expect(f.events[0].distanceM).toBeGreaterThan(1000);
  });

  it('rejects when the job is not active', async () => {
    const f = makeFakes({ status: 'assigned' });
    await expect(f.svc.complete(3, 5, 11, AT_BIN_1)).rejects.toThrow(BadRequestException);
  });

  it('rejects a stop that is not on the route', async () => {
    const f = makeFakes({});
    await expect(f.svc.complete(3, 5, 999, AT_BIN_1)).rejects.toThrow(NotFoundException);
  });

  it('rejects a duplicate completion with 409', async () => {
    const f = makeFakes({
      existing: [{
        id: 1, assignmentId: 5, stopId: 11, driverId: 3, lat: 0, lng: 0,
        accuracyM: null, distanceM: 5, inRange: true, photoPath: 'p', note: null,
        createdAt: new Date(),
      }],
    });
    await expect(f.svc.complete(3, 5, 11, AT_BIN_1)).rejects.toThrow(ConflictException);
  });

  it('auto-completes the job when the last bin lands', async () => {
    const f = makeFakes({
      existing: [{
        id: 1, assignmentId: 5, stopId: 11, driverId: 3, lat: 0, lng: 0,
        accuracyM: null, distanceM: 5, inRange: true, photoPath: 'p', note: null,
        createdAt: new Date(),
      }],
    });
    const r = await f.svc.complete(3, 5, 12, { lat: 0, lng: 0.0101, photoPath: 'completions/y.jpg' });
    expect(r.jobCompleted).toBe(true);
    expect(f.statusCalls).toHaveLength(1);
    expect(f.statusCalls[0]).toEqual([5, 'en_route', 'completed', 'system']);
  });
});
