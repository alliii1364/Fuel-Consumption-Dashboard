import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class StopDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @IsNumber()
  lat: number;

  @IsNumber()
  lng: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  type?: string;

  @IsOptional()
  @IsInt()
  @Min(10)
  radiusM?: number;
}

export class CreateDepotDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name: string;

  @IsNumber()
  lat: number;

  @IsNumber()
  lng: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class CreateRouteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name: string;

  /** Yard/depot this route is anchored to (start & end of the round trip). */
  @IsOptional()
  @IsInt()
  depotId?: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  corridorBufferM?: number;

  /** When true, OSRM reorders the stops into the optimal visiting sequence. */
  @IsOptional()
  @IsBoolean()
  optimize?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StopDto)
  stops?: StopDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  notes?: string;
}

export class UpdateRouteDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsInt()
  depotId?: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  corridorBufferM?: number;

  @IsOptional()
  @IsBoolean()
  optimize?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StopDto)
  stops?: StopDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  notes?: string;
}

export class ImportRouteDto {
  @IsInt()
  gsRouteId: number;

  @IsOptional()
  @IsBoolean()
  optimize?: boolean;
}

export class SetPinDto {
  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'PIN must be 4–8 digits' })
  pin: string;
}

export class CreateDriverDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  assignId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  desc?: string;
}

export class UpdateDriverDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  assignId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  desc?: string;
}

export class CreateAssignmentDto {
  @IsInt()
  routeId: number;

  @IsInt()
  driverId: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  imei: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  priority?: string;

  @IsOptional()
  @IsISO8601()
  scheduledStart?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  notes?: string;
}

export class UpdateStatusDto {
  @IsString()
  @IsNotEmpty()
  status: string;
}

export class UpdateSettingsDto {
  @IsBoolean()
  requireBinPhoto: boolean;
}

// ── Driver Android app ───────────────────────────────────────────────────────

export class RegisterDeviceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  fcmToken: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  platform?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  appVersion?: string;
}

export class LocationPingDto {
  @IsNumber()
  lat: number;

  @IsNumber()
  lng: number;

  @IsOptional()
  @IsNumber()
  speed?: number;

  @IsOptional()
  @IsNumber()
  accuracyM?: number;

  /** Device timestamp (ISO8601 UTC). Defaults to now if omitted. */
  @IsOptional()
  @IsISO8601()
  recordedAt?: string;

  /** Active assignment this ping belongs to, if any. */
  @IsOptional()
  @IsInt()
  assignmentId?: number;
}

export class ReportLocationDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LocationPingDto)
  pings: LocationPingDto[];
}

export class ProofOfDeliveryDto {
  @IsOptional()
  @IsInt()
  stopId?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  note?: string;

  @IsOptional()
  @IsNumber()
  lat?: number;

  @IsOptional()
  @IsNumber()
  lng?: number;
}
