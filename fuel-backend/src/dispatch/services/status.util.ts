import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AssignmentStatus } from './assignment.repository';

/** Forward-only lifecycle. `cancelled` is a side exit available to managers. */
export const STATUS_ORDER: AssignmentStatus[] = [
  'assigned',
  'accepted',
  'en_route',
  'arrived',
  'completed',
];

function isClosed(s: AssignmentStatus): boolean {
  return s === 'completed' || s === 'cancelled';
}

/** A driver may only advance their own job forward; never cancel. */
export function assertDriverTransition(
  from: AssignmentStatus,
  to: AssignmentStatus,
): void {
  if (to === 'cancelled') {
    throw new ForbiddenException('Drivers cannot cancel a job');
  }
  if (isClosed(from)) {
    throw new BadRequestException('Job is already closed');
  }
  const fi = STATUS_ORDER.indexOf(from);
  const ti = STATUS_ORDER.indexOf(to);
  if (ti < 0) throw new BadRequestException(`Invalid status: ${to}`);
  if (ti <= fi) throw new BadRequestException('Cannot move status backward');
}

/** A manager may advance forward or cancel a still-open job. */
export function assertManagerTransition(
  from: AssignmentStatus,
  to: AssignmentStatus,
): void {
  if (isClosed(from)) {
    throw new BadRequestException('Job is already closed');
  }
  if (to === 'cancelled') return;
  const ti = STATUS_ORDER.indexOf(to);
  if (ti < 0) throw new BadRequestException(`Invalid status: ${to}`);
}
