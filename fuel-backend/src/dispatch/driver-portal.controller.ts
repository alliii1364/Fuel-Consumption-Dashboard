import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { promises as fs } from 'fs';
import { join } from 'path';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import {
  AssignmentRepository,
  AssignmentStatus,
} from './services/assignment.repository';
import { RouteRepository } from './services/route.repository';
import { DriverAppRepository } from './services/driver-app.repository';
import { StopCompletionRepository } from './services/stop-completion.repository';
import { StopCompletionService } from './services/stop-completion.service';
import { ManagerSettingsRepository } from './services/manager-settings.repository';
import {
  ProofOfDeliveryDto,
  RegisterDeviceDto,
  ReportLocationDto,
  UpdateStatusDto,
} from './dto/dispatch.dto';
import { assertDriverTransition } from './services/status.util';

const UPLOADS_DIR = process.env.UPLOADS_DIR || join(process.cwd(), 'uploads');

/** Driver PWA / Android app endpoints — scoped to the authenticated driver. */
@Controller('me')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('driver')
export class DriverPortalController {
  constructor(
    private readonly assignments: AssignmentRepository,
    private readonly routes: RouteRepository,
    private readonly driverApp: DriverAppRepository,
    private readonly stopCompletions: StopCompletionService,
    private readonly stopCompletionRepo: StopCompletionRepository,
    private readonly settings: ManagerSettingsRepository,
  ) {}

  @Get('jobs')
  async myJobs(@Request() req: any) {
    const data = await this.assignments.listForDriver(req.user.driverId);
    return { success: true, message: `${data.length} job(s)`, data };
  }

  @Get('jobs/:id')
  async jobDetail(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
    const assignment = await this.assignments.getForDriver(req.user.driverId, id);
    const route = await this.routes.get(assignment.userId, assignment.routeId);
    const stopCompletions = await this.stopCompletionRepo.listForAssignment(
      assignment.assignmentId,
    );
    const { requireBinPhoto } = await this.settings.getSettings(assignment.userId);
    return {
      success: true,
      message: 'Job fetched',
      data: {
        assignment,
        route: {
          routeId: route.routeId,
          name: route.name,
          geometry: route.geometry,
          stops: route.stops,
          totalDistanceKm: route.totalDistanceKm,
          totalDurationS: route.totalDurationS,
        },
        stopCompletions,
        requirePhoto: requireBinPhoto,
      },
    };
  }

  @Patch('jobs/:id/status')
  async updateStatus(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStatusDto,
  ) {
    const current = await this.assignments.getForDriver(req.user.driverId, id);
    const to = dto.status as AssignmentStatus;
    assertDriverTransition(current.status, to);
    await this.assignments.setStatus(id, current.status, to, 'driver');
    const data = await this.assignments.getForDriver(req.user.driverId, id);
    return { success: true, message: `Status set to ${to}`, data };
  }

  /** Register/refresh this device's FCM token for push notifications. */
  @Post('devices')
  async registerDevice(@Request() req: any, @Body() dto: RegisterDeviceDto) {
    await this.driverApp.registerDevice(
      req.user.driverId,
      dto.fcmToken,
      dto.platform || 'android',
      dto.appVersion ?? null,
    );
    return { success: true, message: 'Device registered', data: { ok: true } };
  }

  /**
   * Ingest a batch of phone-GPS pings. Also refreshes the live snapshot of the
   * referenced assignment so the manager's monitor reflects the driver's
   * real-time position.
   */
  @Post('location')
  async reportLocation(@Request() req: any, @Body() dto: ReportLocationDto) {
    const driverId = req.user.driverId;
    let latest: { lat: number; lng: number; at: Date; assignmentId: number | null } | null = null;

    for (const p of dto.pings) {
      const recordedAt = p.recordedAt ? new Date(p.recordedAt) : new Date();
      const assignmentId = p.assignmentId ?? null;
      await this.driverApp.addLocation({
        driverId,
        assignmentId,
        lat: p.lat,
        lng: p.lng,
        speed: p.speed ?? null,
        accuracyM: p.accuracyM ?? null,
        recordedAt,
      });
      if (!latest || recordedAt > latest.at) {
        latest = { lat: p.lat, lng: p.lng, at: recordedAt, assignmentId };
      }
    }

    // Update the assignment's live snapshot with the freshest fix (ownership
    // verified by scoping to this driver's assignment).
    if (latest?.assignmentId) {
      try {
        const a = await this.assignments.getForDriver(driverId, latest.assignmentId);
        await this.assignments.updateProgress(a.assignmentId, {
          lat: latest.lat,
          lng: latest.lng,
          lastSeen: latest.at,
          progressPct: a.progressPct,
          offRoute: a.offRoute,
        });
      } catch {
        // not this driver's assignment — ignore snapshot update
      }
    }

    return { success: true, message: `${dto.pings.length} ping(s) stored`, data: { ok: true } };
  }

  /** Capture proof of delivery (photo + optional note) for an owned job. */
  @Post('jobs/:id/proof')
  @UseInterceptors(FileInterceptor('photo'))
  async proof(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
    @Body() body: ProofOfDeliveryDto & Record<string, string>,
  ) {
    const assignment = await this.assignments.getForDriver(req.user.driverId, id);

    let photoPath: string | null = null;
    if (file?.buffer?.length) {
      const dir = join(UPLOADS_DIR, 'pod');
      await fs.mkdir(dir, { recursive: true });
      const ext = (file.originalname.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
      const name = `pod_${id}_${Date.now()}.${ext}`;
      await fs.writeFile(join(dir, name), file.buffer);
      photoPath = `pod/${name}`;
    }

    const num = (v: any) => (v == null || v === '' ? null : Number(v));
    const podId = await this.driverApp.addPod({
      assignmentId: assignment.assignmentId,
      stopId: body.stopId != null && body.stopId !== ('' as any) ? Number(body.stopId) : null,
      driverId: req.user.driverId,
      photoPath,
      note: body.note || null,
      lat: num(body.lat),
      lng: num(body.lng),
    });

    await this.assignments.addEvent(assignment.assignmentId, {
      type: 'proof_of_delivery',
      stopId: body.stopId ? Number(body.stopId) : null,
      lat: num(body.lat),
      lng: num(body.lng),
      actor: 'driver',
      note: body.note || 'Proof of delivery captured',
    });

    return { success: true, message: 'Proof captured', data: { podId, photoPath } };
  }

  /**
   * Driver marks a bin complete: requires a GPS fix, and a photo when the
   * owning manager's settings require one; the fix is verified against the
   * bin's geofence (out-of-range accepted but flagged). Completing the last
   * bin auto-completes the job.
   */
  @Post('jobs/:id/stops/:stopId/complete')
  @UseInterceptors(FileInterceptor('photo'))
  async completeStop(
    @Request() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Param('stopId', ParseIntPipe) stopId: number,
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
    @Body() body: Record<string, string>,
  ) {
    const assignment = await this.assignments.getForDriver(req.user.driverId, id);
    const { requireBinPhoto } = await this.settings.getSettings(assignment.userId);

    let photoPath: string | null = null;
    if (file?.buffer?.length) {
      const dir = join(UPLOADS_DIR, 'completions');
      await fs.mkdir(dir, { recursive: true });
      const ext = (file.originalname.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
      const name = `bin_${id}_${stopId}_${Date.now()}.${ext}`;
      await fs.writeFile(join(dir, name), file.buffer);
      photoPath = `completions/${name}`;
    }

    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      if (photoPath) await fs.unlink(join(UPLOADS_DIR, photoPath)).catch(() => {});
      throw new BadRequestException('Location is required — enable GPS and try again');
    }

    const accuracyM =
      body.accuracyM != null && body.accuracyM !== '' ? Number(body.accuracyM) : null;
    let data;
    try {
      data = await this.stopCompletions.complete(
        req.user.driverId, id, stopId,
        {
          lat,
          lng,
          accuracyM: Number.isFinite(accuracyM as number) ? accuracyM : null,
          note: body.note || null,
          photoPath,
        },
        requireBinPhoto,
      );
    } catch (err) {
      // Validation failed after the photo hit disk — don't leave an orphan.
      if (photoPath) await fs.unlink(join(UPLOADS_DIR, photoPath)).catch(() => {});
      throw err;
    }
    return {
      success: true,
      message: data.jobCompleted ? 'Bin completed — job finished' : 'Bin completed',
      data,
    };
  }
}
