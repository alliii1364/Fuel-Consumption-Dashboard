import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  username: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  password: string;
}

/** Driver PWA login — by driver ID + numeric PIN. */
export class DriverLoginDto {
  @Type(() => Number)
  @IsInt()
  driverId: number;

  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'PIN must be 4–8 digits' })
  pin: string;
}
