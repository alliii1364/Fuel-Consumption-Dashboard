import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AssignmentRepository } from './assignment.repository';
import { RouteRepository } from './route.repository';
import {
  StopCompletion,
  StopCompletionRepository,
} from './stop-completion.repository';
import { checkCompletionRange } from './completion.util';

const ACTIVE_STATUSES = ['accepted', 'en_route', 'arrived'];

export interface CompleteStopResult {
  completion: StopCompletion;
  /** True when this was the last bin and the job flipped to completed. */
  jobCompleted: boolean;
  stopCompletions: StopCompletion[];
}

/**
 * Driver-confirmed bin completion: verifies the driver's GPS against the
 * bin's geofence (out-of-range is accepted but flagged), records the
 * completion + audit event, and auto-completes the job on the last bin.
 */
@Injectable()
export class StopCompletionService {
  constructor(
    private readonly assignments: AssignmentRepository,
    private readonly routes: RouteRepository,
    private readonly completions: StopCompletionRepository,
  ) {}

  async complete(
    driverId: number,
    assignmentId: number,
    stopId: number,
    input: {
      lat: number;
      lng: number;
      accuracyM?: number | null;
      note?: string | null;
      photoPath: string;
    },
  ): Promise<CompleteStopResult> {
    const assignment = await this.assignments.getForDriver(driverId, assignmentId);
    if (!ACTIVE_STATUSES.includes(assignment.status)) {
      throw new BadRequestException('Job is not active');
    }

    const route = await this.routes.get(assignment.userId, assignment.routeId);
    const stop = route.stops.find((s) => s.stopId === stopId);
    if (!stop) throw new NotFoundException('Stop not found on this route');

    const existing = await this.completions.getForStop(assignmentId, stopId);
    if (existing) {
      throw new ConflictException({
        message: 'Bin already completed',
        completion: existing,
      });
    }

    const check = checkCompletionRange(
      { lat: input.lat, lng: input.lng },
      { lat: stop.lat, lng: stop.lng },
      stop.radiusM,
      input.accuracyM,
    );

    await this.completions.add({
      assignmentId,
      stopId,
      driverId,
      lat: input.lat,
      lng: input.lng,
      accuracyM: input.accuracyM ?? null,
      distanceM: check.distanceM,
      inRange: check.inRange,
      photoPath: input.photoPath,
      note: input.note ?? null,
    });

    const label = stop.name || `stop ${stop.seq}`;
    await this.assignments.addEvent(assignmentId, {
      type: 'stop_completed',
      stopId,
      lat: input.lat,
      lng: input.lng,
      distanceM: check.distanceM,
      actor: 'driver',
      note: check.inRange
        ? `Completed ${label}`
        : `Completed ${label} (out of range, ${check.distanceM}m)`,
    });

    const all = await this.completions.listForAssignment(assignmentId);
    const done = new Set(all.map((c) => c.stopId));
    const jobCompleted = route.stops.every(
      (s) => s.stopId != null && done.has(s.stopId),
    );
    if (jobCompleted) {
      await this.assignments.setStatus(
        assignmentId,
        assignment.status,
        'completed',
        'system',
      );
    }

    return {
      completion: all.find((c) => c.stopId === stopId)!,
      jobCompleted,
      stopCompletions: all,
    };
  }
}
