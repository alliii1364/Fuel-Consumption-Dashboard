import {
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const md5 = require('md5') as (input: string) => string;
import { DriverLoginDto, LoginDto } from './dto/login.dto';

interface GsUser {
  id: number;
  username: string;
  password: string;
  email: string;
  timezone: string;
  active: string;
}

interface DriverCredential {
  driver_id: number;
  user_id: number;
  pin_hash: string;
  active: number;
  driver_name: string | null;
}

/** sha256 hex — used for driver PIN hashes (managers keep the legacy md5/plain scheme). */
export function hashPassword(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto): Promise<{ token: string; expiresIn: string }> {
    const rows: GsUser[] = await this.dataSource.query(
      `SELECT id, username, password, email, timezone, active
       FROM gs_users
       WHERE username = ?
       LIMIT 1`,
      [dto.username],
    );

    if (!rows.length) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const user = rows[0];

    if (user.active !== 'true' && user.active !== '1') {
      throw new UnauthorizedException('Account is inactive');
    }

    const md5Hash = md5(dto.password);
    const passwordMatch =
      user.password === dto.password || user.password === md5Hash;

    if (!passwordMatch) {
      throw new UnauthorizedException('Invalid username or password');
    }

    this.logger.log(`User ${user.username} (id=${user.id}) logged in`);

    const payload = {
      id: user.id,
      username: user.username,
      email: user.email,
      timezone: user.timezone,
      role: 'manager' as const,
    };

    const token = this.jwtService.sign(payload);
    return { token, expiresIn: '24h' };
  }

  /** Driver PWA login — by driver ID + PIN, validated against fd_driver_credentials. */
  async driverLogin(dto: DriverLoginDto): Promise<{
    token: string;
    expiresIn: string;
    driver: { driverId: number; name: string | null };
  }> {
    const rows: DriverCredential[] = await this.dataSource.query(
      `SELECT c.driver_id, c.user_id, c.pin_hash, c.active, d.driver_name
       FROM fd_driver_credentials c
       LEFT JOIN gs_user_object_drivers d ON d.driver_id = c.driver_id
       WHERE c.driver_id = ?
       LIMIT 1`,
      [dto.driverId],
    );

    if (!rows.length) {
      throw new UnauthorizedException('Invalid driver ID or PIN');
    }

    const cred = rows[0];
    if (!cred.active) {
      throw new UnauthorizedException('Account is inactive');
    }
    if (cred.pin_hash !== hashPassword(dto.pin)) {
      throw new UnauthorizedException('Invalid driver ID or PIN');
    }

    this.logger.log(`Driver ${cred.driver_id} logged in`);

    const payload = {
      id: cred.user_id, // owning dispatcher — keeps user-scoped queries working
      role: 'driver' as const,
      driverId: cred.driver_id,
      name: cred.driver_name,
    };

    const token = this.jwtService.sign(payload);
    return {
      token,
      expiresIn: '24h',
      driver: { driverId: cred.driver_id, name: cred.driver_name },
    };
  }
}
