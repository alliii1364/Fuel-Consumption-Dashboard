import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';

export enum FuelIntervalEnum {
  ONE_MIN = '1min',
  FIVE_MIN = '5min',
  FIFTEEN_MIN = '15min',
  HOUR = 'hour',
  DAY = 'day',
}

export class FuelHistoryDto {
  @IsISO8601()
  from: string;

  @IsISO8601()
  to: string;

  @IsOptional()
  @IsEnum(FuelIntervalEnum, {
    message: 'interval must be one of: 1min, 5min, 15min, hour, day',
  })
  interval?: FuelIntervalEnum;

  @IsOptional()
  @IsString()
  tz?: string;
}
