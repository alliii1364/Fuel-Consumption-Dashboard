import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { hashPassword } from '../../auth/auth.service';

export interface DriverRecord {
  driverId: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  assignId: string | null;
  address: string | null;
  desc: string | null;
  hasLogin: boolean;
  loginActive: boolean;
}

export interface DriverInput {
  name: string;
  phone?: string;
  email?: string;
  assignId?: string;
  address?: string;
  desc?: string;
}

/**
 * Reads the existing platform driver registry (gs_user_object_drivers, scoped
 * by user_id) and joins our fd_driver_credentials for PWA login state.
 */
@Injectable()
export class DriverRepository {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async list(userId: number): Promise<DriverRecord[]> {
    const rows = await this.ds.query(
      `SELECT d.driver_id, d.driver_name, d.driver_phone, d.driver_email,
              d.driver_assign_id, d.driver_address, d.driver_desc,
              c.driver_id AS cred_id, c.active AS login_active
       FROM gs_user_object_drivers d
       LEFT JOIN fd_driver_credentials c ON c.driver_id = d.driver_id
       WHERE d.user_id = ?
       ORDER BY d.driver_name ASC`,
      [userId],
    );
    return rows.map((r: any) => this.map(r));
  }

  async get(userId: number, driverId: number): Promise<DriverRecord> {
    const rows = await this.ds.query(
      `SELECT d.driver_id, d.driver_name, d.driver_phone, d.driver_email,
              d.driver_assign_id, d.driver_address, d.driver_desc,
              c.driver_id AS cred_id, c.active AS login_active
       FROM gs_user_object_drivers d
       LEFT JOIN fd_driver_credentials c ON c.driver_id = d.driver_id
       WHERE d.user_id = ? AND d.driver_id = ?
       LIMIT 1`,
      [userId, driverId],
    );
    if (!rows.length) throw new NotFoundException('Driver not found');
    return this.map(rows[0]);
  }

  /**
   * Create a driver in the platform registry (gs_user_object_drivers), scoped to
   * the dispatcher. The legacy table has NOT-NULL text columns with no defaults,
   * so unsupplied fields are stored as empty strings.
   */
  async create(userId: number, data: DriverInput): Promise<number> {
    const res = await this.ds.query(
      `INSERT INTO gs_user_object_drivers
         (user_id, driver_name, driver_assign_id, driver_idn, driver_address,
          driver_phone, driver_email, driver_desc, driver_img_file)
       VALUES (?, ?, ?, '', ?, ?, ?, ?, '')`,
      [
        userId,
        data.name,
        data.assignId ?? '',
        data.address ?? '',
        data.phone ?? '',
        data.email ?? '',
        data.desc ?? '',
      ],
    );
    return res.insertId as number;
  }

  /** Update an owned driver's editable profile fields. */
  async update(userId: number, driverId: number, patch: Partial<DriverInput>): Promise<void> {
    await this.assertOwned(userId, driverId);
    const fields: string[] = [];
    const params: any[] = [];
    const set = (col: string, val: any) => {
      if (val !== undefined) {
        fields.push(`${col} = ?`);
        params.push(val);
      }
    };
    set('driver_name', patch.name);
    set('driver_phone', patch.phone);
    set('driver_email', patch.email);
    set('driver_assign_id', patch.assignId);
    set('driver_address', patch.address);
    set('driver_desc', patch.desc);
    if (!fields.length) return;
    params.push(driverId, userId);
    await this.ds.query(
      `UPDATE gs_user_object_drivers SET ${fields.join(', ')}
       WHERE driver_id = ? AND user_id = ?`,
      params,
    );
  }

  /**
   * Delete an owned driver. Blocked while the driver has in-flight assignments
   * or an active login (disable the login first). Cleans up any disabled
   * credential row on success.
   */
  async remove(userId: number, driverId: number): Promise<void> {
    await this.assertOwned(userId, driverId);

    const [active] = await this.ds.query(
      `SELECT COUNT(*) AS c FROM fd_assignments
       WHERE driver_id = ? AND user_id = ? AND status NOT IN ('completed','cancelled')`,
      [driverId, userId],
    );
    if (Number(active.c) > 0) {
      throw new ConflictException('Driver has active assignments — cancel or complete them first');
    }

    const [cred] = await this.ds.query(
      `SELECT active FROM fd_driver_credentials WHERE driver_id = ? LIMIT 1`,
      [driverId],
    );
    if (cred && (cred.active === 1 || cred.active === '1')) {
      throw new ConflictException('Disable the driver login before deleting');
    }

    await this.ds.query(`DELETE FROM fd_driver_credentials WHERE driver_id = ?`, [driverId]);
    await this.ds.query(
      `DELETE FROM gs_user_object_drivers WHERE driver_id = ? AND user_id = ?`,
      [driverId, userId],
    );
  }

  /** Verify a driver belongs to this dispatcher. Throws if not. */
  async assertOwned(userId: number, driverId: number): Promise<void> {
    const rows = await this.ds.query(
      `SELECT 1 FROM gs_user_object_drivers WHERE user_id = ? AND driver_id = ? LIMIT 1`,
      [userId, driverId],
    );
    if (!rows.length) throw new NotFoundException('Driver not found');
  }

  /** Set (or reset) an owned driver's login PIN. Re-enables the login. */
  async setPin(userId: number, driverId: number, pin: string): Promise<void> {
    await this.assertOwned(userId, driverId);
    const hash = hashPassword(pin);
    await this.ds.query(
      `INSERT INTO fd_driver_credentials (driver_id, user_id, pin_hash, active)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE pin_hash = VALUES(pin_hash), active = 1`,
      [driverId, userId, hash],
    );
  }

  async setLoginActive(
    userId: number,
    driverId: number,
    active: boolean,
  ): Promise<void> {
    await this.assertOwned(userId, driverId);
    await this.ds.query(
      `UPDATE fd_driver_credentials SET active = ? WHERE driver_id = ?`,
      [active ? 1 : 0, driverId],
    );
  }

  private map(r: any): DriverRecord {
    return {
      driverId: r.driver_id,
      name: r.driver_name,
      phone: r.driver_phone,
      email: r.driver_email,
      assignId: r.driver_assign_id || null,
      address: r.driver_address || null,
      desc: r.driver_desc || null,
      hasLogin: r.cred_id != null,
      loginActive: r.login_active === 1 || r.login_active === '1',
    };
  }
}
