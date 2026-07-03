import {
  Module,
  MiddlewareConsumer,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { FuelController } from './fuel.controller';
import { FuelSensorResolverService } from './services/fuel-sensor-resolver.service';
import { FuelTransformService } from './services/fuel-transform.service';
import { DynamicTableQueryService } from './services/dynamic-table-query.service';
import { FuelHistoryService } from './services/fuel-history.service';
import { FuelConsumptionService } from './services/fuel-consumption.service';
import { FuelStatsService } from './services/fuel-stats.service';
import { ThriftService } from './services/thrift.service';
import { TheftDetectionService } from './services/theft-detection.service';
import { TripAnalyzerService } from './services/trip-analyzer.service';
import { FuelAnomalyMiddleware } from '../common/middleware/fuel-anomaly.middleware';
import { FuelDailyRepository } from './rollup/fuel-daily.repository';
import { FuelRollupService } from './rollup/fuel-rollup.service';
import { FuelRollupCron } from './rollup/fuel-rollup.cron';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [FuelController],
  providers: [
    FuelSensorResolverService,
    FuelTransformService,
    DynamicTableQueryService,
    FuelHistoryService,
    FuelConsumptionService,
    FuelStatsService,
    ThriftService,
    TheftDetectionService,
    TripAnalyzerService,
    FuelAnomalyMiddleware,
    FuelDailyRepository,
    FuelRollupService,
    FuelRollupCron,
  ],
  exports: [
    FuelSensorResolverService,
    FuelTransformService,
    DynamicTableQueryService,
    FuelHistoryService,
    FuelConsumptionService,
    FuelStatsService,
    ThriftService,
    TheftDetectionService,
    TripAnalyzerService,
    FuelAnomalyMiddleware,
    FuelRollupService,
  ],
})
export class FuelModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(FuelAnomalyMiddleware).forRoutes(
      // Apply to all fuel-related routes under vehicles/:imei/fuel/
      { path: 'vehicles/:imei/fuel/consumption', method: RequestMethod.GET },
      { path: 'vehicles/:imei/fuel/history', method: RequestMethod.GET },
      { path: 'vehicles/:imei/fuel/stats', method: RequestMethod.GET },
      { path: 'vehicles/:imei/fuel/refuels', method: RequestMethod.GET },
      { path: 'vehicles/:imei/fuel/debug', method: RequestMethod.GET },
      { path: 'vehicles/:imei/fuel/thrift', method: RequestMethod.GET },
      { path: 'vehicles/:imei/fuel/theft', method: RequestMethod.GET },
    );
  }
}
