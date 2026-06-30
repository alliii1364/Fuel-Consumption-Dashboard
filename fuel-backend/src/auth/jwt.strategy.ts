import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export type AppRole = 'manager' | 'driver';

export interface JwtPayload {
  id: number; // gs_users.id (manager) or the owning user for a driver
  username: string;
  email?: string;
  timezone?: string;
  role: AppRole;
  driverId?: number; // present only when role === 'driver'
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload> {
    // Driver tokens are validated against the dispatch credentials table.
    if (payload.role === 'driver') {
      const rows: Array<{ driver_id: number }> = await this.dataSource.query(
        `SELECT driver_id FROM fd_driver_credentials WHERE driver_id = ? AND active = 1 LIMIT 1`,
        [payload.driverId],
      );
      if (!rows.length) {
        throw new UnauthorizedException('Driver not found or inactive');
      }
      return payload;
    }

    // Manager tokens (default) re-check the platform user table.
    const rows: Array<{ id: number }> = await this.dataSource.query(
      `SELECT id FROM gs_users WHERE id = ? AND active = 'true' LIMIT 1`,
      [payload.id],
    );
    if (!rows.length) {
      throw new UnauthorizedException('User not found or inactive');
    }
    return { ...payload, role: 'manager' };
  }
}
