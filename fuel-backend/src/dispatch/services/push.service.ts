import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { existsSync } from 'fs';
import { join } from 'path';
import * as admin from 'firebase-admin';
import { DriverAppRepository } from './driver-app.repository';

export interface PushPayload {
  title: string;
  body: string;
  /** Extra key/values delivered to the app (e.g. { jobId: "12" }). */
  data?: Record<string, string>;
}

/**
 * Sends Firebase Cloud Messaging notifications to drivers' devices. Initialises
 * lazily from a service-account key (FCM_SERVICE_ACCOUNT env or
 * fcm-service-account.json at the backend root). If the key is absent it stays
 * disabled and silently no-ops, so the app runs fine without push configured.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private enabled = false;

  constructor(private readonly driverApp: DriverAppRepository) {}

  onModuleInit(): void {
    const keyPath =
      process.env.FCM_SERVICE_ACCOUNT || join(process.cwd(), 'fcm-service-account.json');
    if (!existsSync(keyPath)) {
      this.logger.warn(
        `Push disabled — no FCM service-account key at ${keyPath}. Set FCM_SERVICE_ACCOUNT to enable.`,
      );
      return;
    }
    try {
      if (!admin.apps.length) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const serviceAccount = require(keyPath);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      }
      this.enabled = true;
      this.logger.log('Push enabled (Firebase Cloud Messaging).');
    } catch (err) {
      this.logger.error(`Push init failed: ${String(err)}`);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Push to every device registered for a driver. Best-effort; never throws. */
  async sendToDriver(driverId: number, payload: PushPayload): Promise<void> {
    if (!this.enabled) return;
    let tokens: string[] = [];
    try {
      tokens = await this.driverApp.tokensForDriver(driverId);
    } catch (err) {
      this.logger.warn(`Could not load device tokens for driver ${driverId}: ${String(err)}`);
      return;
    }
    if (!tokens.length) return;

    try {
      const res = await admin.messaging().sendEachForMulticast({
        tokens,
        notification: { title: payload.title, body: payload.body },
        data: payload.data ?? {},
        android: { priority: 'high', notification: { sound: 'default' } },
      });

      // Prune tokens FCM reports as permanently invalid.
      const dead: string[] = [];
      res.responses.forEach((r, i) => {
        const code = r.error?.code;
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-argument'
        ) {
          dead.push(tokens[i]);
        }
      });
      if (dead.length) await this.driverApp.removeTokens(dead);

      this.logger.log(
        `Push to driver ${driverId}: ${res.successCount}/${tokens.length} delivered` +
          (dead.length ? `, pruned ${dead.length} dead token(s)` : ''),
      );
    } catch (err) {
      this.logger.warn(`Push send failed for driver ${driverId}: ${String(err)}`);
    }
  }
}
