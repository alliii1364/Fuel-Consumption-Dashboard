import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface ManagerSettings {
  requireBinPhoto: boolean;
}

@Injectable()
export class ManagerSettingsRepository {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async getSettings(userId: number): Promise<ManagerSettings> {
    const rows = await this.ds.query(
      `SELECT require_bin_photo FROM fd_manager_settings WHERE user_id = ? LIMIT 1`,
      [userId],
    );
    if (!rows.length) return { requireBinPhoto: true };
    return { requireBinPhoto: rows[0].require_bin_photo === 1 };
  }

  async upsertSettings(userId: number, s: { requireBinPhoto: boolean }): Promise<void> {
    await this.ds.query(
      `INSERT INTO fd_manager_settings (user_id, require_bin_photo)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE require_bin_photo = VALUES(require_bin_photo)`,
      [userId, s.requireBinPhoto ? 1 : 0],
    );
  }
}
