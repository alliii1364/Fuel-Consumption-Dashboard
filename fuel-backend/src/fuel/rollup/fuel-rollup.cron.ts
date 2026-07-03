import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FuelRollupService } from './fuel-rollup.service';
import { FuelSensorResolverService } from '../services/fuel-sensor-resolver.service';
import { karachiDayStrs } from './karachi-day.util';

@Injectable()
export class FuelRollupCron {
  private readonly logger = new Logger(FuelRollupCron.name);
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly rollup: FuelRollupService,
    private readonly sensors: FuelSensorResolverService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async roll(): Promise<void> {
    if (process.env.FUEL_ROLLUP !== '1') return;
    const to = new Date();
    const from = new Date(to.getTime() - 2 * 24 * 60 * 60 * 1000); // last ~2 days
    const days = karachiDayStrs(from, to);
    const objs: any[] = await this.ds.query(`SELECT imei, fcr FROM gs_objects WHERE dt_tracker >= ?`, [from]);
    for (const o of objs) {
      try {
        const sensor = await this.sensors.resolveFuelSensor(o.imei);
        for (const d of days) await this.rollup.computeAndStoreDay(o.imei, sensor, d, o.fcr ?? '');
      } catch (e) { this.logger.warn(`rollup ${o.imei}: ${String(e)}`); }
      await new Promise((r) => setTimeout(r, 200)); // gentle on the shared DB
    }
  }
}
