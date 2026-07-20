import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { RouteRepository, RouteStop, RouteDepot } from './services/route.repository';
import { DepotRepository } from './services/depot.repository';
import { RoutePlannerService } from './services/route-planner.service';
import { KmlImportService } from './services/kml-import.service';
import {
  CreateRouteDto,
  ImportRouteDto,
  UpdateRouteDto,
} from './dto/dispatch.dto';

const DEFAULT_CORRIDOR_M = 150;

@Controller('routes')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('manager')
export class RoutesController {
  constructor(
    private readonly routes: RouteRepository,
    private readonly depots: DepotRepository,
    private readonly planner: RoutePlannerService,
    private readonly kml: KmlImportService,
  ) {}

  @Get()
  async list(@Request() req: any) {
    const data = await this.routes.list(req.user.id);
    return { success: true, message: `${data.length} route(s)`, data };
  }

  /** Existing gs_user_routes that can be imported. */
  @Get('importable')
  async importable(@Request() req: any) {
    const data = await this.routes.listImportableGsRoutes(req.user.id);
    return { success: true, message: `${data.length} importable route(s)`, data };
  }

  @Get(':routeId')
  async get(@Request() req: any, @Param('routeId', ParseIntPipe) routeId: number) {
    const data = await this.routes.get(req.user.id, routeId);
    return { success: true, message: 'Route fetched', data };
  }

  @Post()
  async create(@Request() req: any, @Body() dto: CreateRouteDto) {
    const bins = this.toStops(dto.stops || []);

    // A depot anchors the route as a round trip (yard → bins → yard);
    // without one we fall back to a legacy open-path route.
    if (dto.depotId != null) {
      const depot = await this.depots.get(req.user.id, dto.depotId);
      const planned = await this.planner.planRoundTrip(
        { lat: depot.lat, lng: depot.lng },
        bins,
        dto.optimize ?? false,
      );
      const routeId = await this.routes.create(req.user.id, {
        name: dto.name,
        source: planned.optimized ? 'optimized' : 'manual',
        geometry: planned.geometry,
        corridorBufferM: dto.corridorBufferM ?? DEFAULT_CORRIDOR_M,
        totalDistanceKm: planned.distanceKm,
        totalDurationS: planned.durationS,
        optimized: planned.optimized,
        notes: dto.notes ?? null,
        depot: { depotId: depot.depotId, name: depot.name, lat: depot.lat, lng: depot.lng },
        stops: planned.stops,
      });
      const data = await this.routes.get(req.user.id, routeId);
      return { success: true, message: 'Route created', data: { ...data, degraded: planned.degraded } };
    }

    const planned = await this.planner.plan(bins, dto.optimize ?? false);
    const routeId = await this.routes.create(req.user.id, {
      name: dto.name,
      source: planned.optimized ? 'optimized' : 'manual',
      geometry: planned.geometry,
      corridorBufferM: dto.corridorBufferM ?? DEFAULT_CORRIDOR_M,
      totalDistanceKm: planned.distanceKm,
      totalDurationS: planned.durationS,
      optimized: planned.optimized,
      notes: dto.notes ?? null,
      stops: planned.stops,
    });
    const data = await this.routes.get(req.user.id, routeId);
    return { success: true, message: 'Route created', data: { ...data, degraded: planned.degraded } };
  }

  /** Import a legacy gs_user_routes polyline into an editable fd_route. */
  @Post('import')
  async import(@Request() req: any, @Body() dto: ImportRouteDto) {
    const src = await this.routes.getGsRoute(req.user.id, dto.gsRouteId);
    if (src.points.length < 2) {
      throw new BadRequestException('Source route has no usable points');
    }
    // Treat the first and last polyline points as stops; keep the full
    // polyline as geometry (or re-optimize endpoints if requested).
    const endpoints: RouteStop[] = [
      { seq: 1, name: 'Start', lat: src.points[0].lat, lng: src.points[0].lng, type: 'pickup', radiusM: 100 },
      {
        seq: 2,
        name: 'End',
        lat: src.points[src.points.length - 1].lat,
        lng: src.points[src.points.length - 1].lng,
        type: 'dropoff',
        radiusM: 100,
      },
    ];

    let geometry = src.points;
    let distanceKm: number | null = null;
    let durationS: number | null = null;
    let optimized = false;
    if (dto.optimize) {
      const planned = await this.planner.plan(endpoints, false);
      geometry = planned.geometry;
      distanceKm = planned.distanceKm;
      durationS = planned.durationS;
      optimized = false;
    }

    const routeId = await this.routes.create(req.user.id, {
      name: src.name,
      source: 'imported',
      gsRouteId: dto.gsRouteId,
      geometry,
      corridorBufferM: src.corridorBufferM,
      totalDistanceKm: distanceKm,
      totalDurationS: durationS,
      optimized,
      stops: endpoints,
    });
    const data = await this.routes.get(req.user.id, routeId);
    return { success: true, message: 'Route imported', data };
  }

  /** Upload a KML file → stops/path → (optionally optimized) route. */
  @Post('upload-kml')
  @UseInterceptors(FileInterceptor('file'))
  async uploadKml(
    @Request() req: any,
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
    @Query('name') name?: string,
    @Query('corridorBufferM') corridorBufferM?: string,
    @Query('optimize') optimize?: string,
  ) {
    if (!file) throw new BadRequestException('No KML file uploaded');
    const parsed = this.kml.parse(file.buffer.toString('utf8'));

    // Prefer explicit point placemarks as stops; otherwise sample the path.
    let stops: RouteStop[] = this.toStops(
      parsed.stops.map((s) => ({ name: s.name, lat: s.lat, lng: s.lng })),
    );
    if (stops.length === 0 && parsed.path.length >= 2) {
      const first = parsed.path[0];
      const last = parsed.path[parsed.path.length - 1];
      stops = this.toStops([
        { name: 'Start', lat: first.lat, lng: first.lng },
        { name: 'End', lat: last.lat, lng: last.lng },
      ]);
    }
    if (stops.length === 0) {
      throw new BadRequestException('KML contained no usable stops');
    }

    const wantOptimize = optimize === 'true' || optimize === '1';
    const planned = await this.planner.plan(stops, wantOptimize);
    // If the KML carried an explicit path and we didn't optimize, keep it.
    const geometry =
      !wantOptimize && parsed.path.length >= 2 ? parsed.path : planned.geometry;

    const routeId = await this.routes.create(req.user.id, {
      name: name?.trim() || file.originalname.replace(/\.kml$/i, '') || 'Imported KML',
      source: 'kml',
      geometry,
      corridorBufferM: corridorBufferM ? parseInt(corridorBufferM, 10) : DEFAULT_CORRIDOR_M,
      totalDistanceKm: planned.distanceKm,
      totalDurationS: planned.durationS,
      optimized: planned.optimized,
      stops: planned.stops,
    });
    const data = await this.routes.get(req.user.id, routeId);
    return { success: true, message: 'KML imported', data };
  }

  @Patch(':routeId')
  async update(
    @Request() req: any,
    @Param('routeId', ParseIntPipe) routeId: number,
    @Body() dto: UpdateRouteDto,
  ) {
    const patch: any = {
      name: dto.name,
      corridorBufferM: dto.corridorBufferM,
      notes: dto.notes,
    };
    // Re-plan geometry only when stops are provided.
    let degraded = false;
    if (dto.stops) {
      const bins = this.toStops(dto.stops);

      // Resolve the anchoring depot: an explicit depotId wins, otherwise reuse
      // whatever this route was already anchored to (so an edit stays a round trip).
      let depot: RouteDepot | null = null;
      if (dto.depotId != null) {
        const d = await this.depots.get(req.user.id, dto.depotId);
        depot = { depotId: d.depotId, name: d.name, lat: d.lat, lng: d.lng };
      } else {
        const existing = await this.routes.get(req.user.id, routeId);
        depot = existing.depot;
      }

      const planned = depot
        ? await this.planner.planRoundTrip({ lat: depot.lat, lng: depot.lng }, bins, dto.optimize ?? false)
        : await this.planner.plan(bins, dto.optimize ?? false);
      patch.stops = planned.stops;
      patch.geometry = planned.geometry;
      patch.totalDistanceKm = planned.distanceKm;
      patch.totalDurationS = planned.durationS;
      patch.optimized = planned.optimized;
      patch.depot = depot;
      degraded = planned.degraded;
    }
    await this.routes.update(req.user.id, routeId, patch);
    const data = await this.routes.get(req.user.id, routeId);
    return { success: true, message: 'Route updated', data: { ...data, degraded } };
  }

  @Delete(':routeId')
  async remove(@Request() req: any, @Param('routeId', ParseIntPipe) routeId: number) {
    await this.routes.remove(req.user.id, routeId);
    return { success: true, message: 'Route deleted', data: { routeId } };
  }

  private toStops(
    raw: Array<{ name?: string; lat: number; lng: number; type?: string; radiusM?: number }>,
  ): RouteStop[] {
    return raw.map((s, i) => ({
      seq: i + 1,
      name: s.name ?? null,
      lat: s.lat,
      lng: s.lng,
      type: s.type || 'stop',
      radiusM: s.radiusM || 100,
    }));
  }
}
