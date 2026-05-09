import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { FuelSensor } from './fuel-sensor-resolver.service';
import { FuelTransformService } from './fuel-transform.service';
import { DynamicTableQueryService } from './dynamic-table-query.service';
import { DataRow } from './dynamic-table-query.service';
import {
  FuelReading,
  applyMedianFilter,
  isFakeSpike,
  isFakeRise,
  isDropConfirmedAfterDelay,
  isPostDropRecovery,
  isRecoveryRise,
  isStationaryDropRecovery,
  isPostRefuelFallback,
  DROP_ALERT_THRESHOLD,
  RISE_THRESHOLD,
  SPIKE_WINDOW_MINUTES,
  FUEL_MEDIAN_SAMPLES,
  REFUEL_CONSOLIDATION_MINUTES,
  POST_REFUEL_VERIFY_EPS_LITERS,
} from './fuel-drop-filter.util';

/**
 * How many hours of data to fetch BEFORE the requested `from` date in order to
 * warm up the causal median filter.  Without this, the first few readings in
 * any query window are smoothed from an incomplete window, producing different
 * median values for the same sensor readings depending on the query range —
 * causing "This Week" and "This Month" to disagree on the same refuel events.
 *
 * With a full 5-sample causal filter and data arriving every ~1–2 min,
 * 2 hours is more than enough to saturate the window even for sparse datasets.
 */
const WARMUP_HOURS = 2;

const NOISE_THRESHOLD = 0.5;
/** Used ONLY inside the drop window scan to detect a mid-window refuel and break early. */
const REFUEL_THRESHOLD = 3.0;
const REFUEL_MOVEMENT_MAX_SPEED_KMH = 10.0;
const REFUEL_WINDOW_BOUNDARY_MINUTES = 5;

// Mirrors Python's MILEAGE_MAX_LITER_DROP_PER_READING = 2.0
const MAX_SINGLE_READING_DROP = 2.0;

export interface RefuelEvent {
  at: string;
  fuelBefore: number;
  fuelAfter: number;
  added: number;
  unit: string;
  /** True for events sourced from the Python fuel_rise_alerts table — skip middleware re-validation. */
  isPythonConfirmed?: boolean;
}

export interface DropEvent {
  at: string;
  fuelBefore: number;
  fuelAfter: number;
  consumed: number;
  unit: string;
  /** True when a single-reading drop exceeds MAX_SINGLE_READING_DROP — likely a sensor glitch, not real consumption (mirrors Python's MILEAGE_MAX_LITER_DROP_PER_READING check). */
  isSensorJump?: boolean;
  /**
   * True when ALL three conditions hold, mirroring Python's is_fake_spike() logic:
   *   1. consumed >= DROP_ALERT_THRESHOLD (8 L)
   *   2. The fuel level does NOT recover within ±SPIKE_WINDOW_MINUTES (7 min)
   *   3. Fuel stays consistently low after the drop
   * Only confirmed drops are shown as "Fuel Drop Alert" events in the UI.
   */
  isConfirmedDrop?: boolean;
}

export interface ConsumptionResult {
  imei: string;
  from: string;
  to: string;
  /** Cumulative small-drop consumption (excludes sensor jumps > MAX_SINGLE_READING_DROP). */
  consumed: number;
  refueled: number;
  estimatedCost: number | null;
  unit: string;
  refuelEvents: number;
  samples: number;
  refuels: RefuelEvent[];
  drops: DropEvent[];
  /** First valid fuel reading in the period (liters). */
  firstFuel: number | null;
  /** Last valid fuel reading in the period (liters). */
  lastFuel: number | null;
  /**
   * Net fuel change = firstFuel − lastFuel.
   * Positive = net decrease (fuel was consumed / stolen).
   * This is the most accurate single-number representation of "how much fuel
   * was lost" because it does NOT double-count sensor oscillations.
   */
  netDrop: number | null;
  /**
   * Raw fuel readings (for anomaly detection middleware).
   * Optional - only included if readings are available.
   */
  readings?: FuelReading[];
}

export interface FcrConfig {
  source?: string;
  measurement?: string;
  cost?: string;
  summer?: string;
  winter?: string;
}

export interface PythonDropAlert {
  at: string;
  fuelBefore: number;
  fuelAfter: number;
  consumed: number;
  unit: string;
  isConfirmedDrop: true;
}

@Injectable()
export class FuelConsumptionService {
  private readonly logger = new Logger(FuelConsumptionService.name);

  constructor(
    private readonly transform: FuelTransformService,
    private readonly dynQuery: DynamicTableQueryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Query fuel_drop_alerts (written by the Python monitoring script) for
   * confirmed theft/drop events in the given UTC range.
   *
   * Python stores dt_tracker as raw UTC DATETIME. TypeORM uses timezone:'Z'
   * which sets the MySQL session to UTC, so stored UTC values are read back
   * correctly as UTC JavaScript Dates.
   */
  async getPythonAlerts(
    imei: string,
    from: Date,
    to: Date,
    unit = 'Liters',
  ): Promise<PythonDropAlert[]> {
    try {
      const rows = await this.dataSource.query<
        {
          alert_id: number;
          imei: string;
          previous_fuel: number;
          current_fuel: number;
          drop_amount: number;
          dt_tracker: Date;
        }[]
      >(
        `SELECT alert_id, imei, previous_fuel, current_fuel, drop_amount, dt_tracker
         FROM fuel_drop_alerts
         WHERE imei = ? AND dt_tracker BETWEEN ? AND ? AND drop_amount >= ?
         ORDER BY dt_tracker ASC`,
        [imei, from, to, DROP_ALERT_THRESHOLD],
      );

      // Filter out sensor-spike drops: if the next Python drop (within 30 min)
      // starts from a fuel level that represents ≥50% recovery of this drop's
      // magnitude, the fuel recovered between the two → current drop was an
      // oscillation, not a real loss.
      //
      // Uses ratio (not absolute) so large real drops with minor post-drop
      // sensor drift are never mistakenly filtered.
      const SPIKE_RECOVERY_RATIO  = 0.5;  // ≥50% recovery = spike
      const SPIKE_RECOVERY_MAX_MS = 30 * 60 * 1000;
      const filtered = rows.filter((r, idx) => {
        const next = rows[idx + 1];
        if (!next) return true;
        const gapMs = new Date(next.dt_tracker).getTime() - new Date(r.dt_tracker).getTime();
        if (gapMs > SPIKE_RECOVERY_MAX_MS) return true;
        const dropMagnitude = r.previous_fuel - r.current_fuel;
        if (dropMagnitude <= 0) return true;
        const recoveryAmount = next.previous_fuel - r.current_fuel;
        const recovered = recoveryAmount / dropMagnitude > SPIKE_RECOVERY_RATIO;
        if (recovered) {
          this.logger.log(
            `[DropAlerts] IMEI ${imei} at ${new Date(r.dt_tracker).toISOString()}: ` +
            `SPIKE RECOVERY — drop ${r.previous_fuel.toFixed(1)}→${r.current_fuel.toFixed(1)}L ` +
            `(${dropMagnitude.toFixed(1)}L) but next drop starts at ${next.previous_fuel.toFixed(1)}L ` +
            `(${(recoveryAmount / dropMagnitude * 100).toFixed(0)}% recovery), skipping`,
          );
        }
        return !recovered;
      });

      return filtered.map((r) => ({
        at: r.dt_tracker instanceof Date
          ? r.dt_tracker.toISOString()
          : new Date(r.dt_tracker).toISOString(),
        fuelBefore: Math.round(r.previous_fuel * 100) / 100,
        fuelAfter: Math.round(r.current_fuel * 100) / 100,
        consumed: Math.round(r.drop_amount * 100) / 100,
        unit,
        isConfirmedDrop: true as const,
      }));
    } catch (err) {
      this.logger.warn(`getPythonAlerts error for IMEI ${imei}: ${err}`);
      return [];
    }
  }

  /**
   * Query fuel_rise_alerts (written by the Python monitoring script) for
   * confirmed refuel events in the given UTC range.
   * Only returns events with rise_amount >= DROP_ALERT_THRESHOLD (8L) to
   * match the JS detection threshold and suppress sub-threshold noise.
   */
  async getPythonRefuels(
    imei: string,
    from: Date,
    to: Date,
    unit = 'Liters',
  ): Promise<RefuelEvent[]> {
    try {
      const rows = await this.dataSource.query<{
        alert_id: number;
        imei: string;
        previous_fuel: number;
        current_fuel: number;
        rise_amount: number;
        dt_tracker: Date;
      }[]>(
        `SELECT alert_id, imei, previous_fuel, current_fuel, rise_amount, dt_tracker
         FROM fuel_rise_alerts
         WHERE imei = ? AND dt_tracker BETWEEN ? AND ? AND rise_amount >= ?
         ORDER BY dt_tracker ASC`,
        [imei, from, to, DROP_ALERT_THRESHOLD],
      );

      return rows.map((r) => ({
        at: r.dt_tracker instanceof Date
          ? r.dt_tracker.toISOString()
          : new Date(r.dt_tracker).toISOString(),
        fuelBefore: Math.round(r.previous_fuel * 100) / 100,
        fuelAfter: Math.round(r.current_fuel * 100) / 100,
        added: Math.round(r.rise_amount * 100) / 100,
        unit,
        isPythonConfirmed: true,
      }));
    } catch (err) {
      this.logger.warn(`getPythonRefuels error for IMEI ${imei}: ${err}`);
      return [];
    }
  }

  async getConsumption(
    imei: string,
    from: Date,
    to: Date,
    sensor: FuelSensor,
    fcrJson: string,
  ): Promise<ConsumptionResult> {
    const warmupFrom = new Date(from.getTime() - WARMUP_HOURS * 60 * 60 * 1000);
    const allRows = await this.dynQuery.getRowsInRange(imei, warmupFrom, to);
    this.logger.log(
      `Consumption for IMEI ${imei}: fetched ${allRows.length} rows (${WARMUP_HOURS}h warmup from ${warmupFrom.toISOString()})`,
    );
  
    const { drops: allDrops, refuels: allRefuels, readings, rejectedRises } = this.analyzeRows(allRows, sensor, imei);

    const fromIso = from.toISOString();
    const drops   = allDrops.filter((d) => d.at >= fromIso);
    const jsRefuels = allRefuels.filter((r) => r.at >= fromIso);

    // JS detection is the primary source — it uses a median filter + confirmation
    // logic that rejects sensor noise better than the Python script.
    // Python refuels (fuel_rise_alerts) are used ONLY when JS found zero refuels
    // in the period, which happens when pre-refuel sensor noise prevents JS from
    // detecting the rise (e.g. noisy driving before stopping to refuel).
    //
    // Even then, Python entries that match a recent unconfirmed fake downward spike
    // are filtered out — Python can record sensor oscillations during vehicle
    // operation as "refuels", the same pattern the isFakeDropRecovery guard handles
    // in analyzeRows (fake drop + rise-to-original-level = sensor noise, not refuel).
    const rawPythonRefuels = jsRefuels.length === 0
      ? await this.getPythonRefuels(imei, from, to, sensor.units || 'L')
      : [];
    this.logger.log(
      `[PythonFilter] IMEI ${imei}: jsRefuels=${jsRefuels.length}, rawPythonRefuels=${rawPythonRefuels.length}, from=${from.toISOString()}, to=${to.toISOString()}`,
    );
    const pythonRefuels = rawPythonRefuels.filter((pr) => {
      const prMs = new Date(pr.at).getTime();

      // Reject if a nearby confirmed drop exists (theft/refuel pair — legitimate).
      const hasNearbyConfirmedDrop = allDrops.some(
        (d) => d.isConfirmedDrop &&
          Math.abs(new Date(d.at).getTime() - prMs) < 60 * 60 * 1000,
      );

      // Filter A: matches a recent unconfirmed fake drop's dip/pre-drop levels.
      const matchesFakeDrop = !hasNearbyConfirmedDrop && allDrops.some((d) => {
        if (d.isConfirmedDrop) return false;
        const dropAt = new Date(d.at).getTime();
        return (
          prMs - dropAt < 30 * 60 * 1000 &&
          Math.abs(d.fuelAfter - pr.fuelBefore) < 5.0 &&
          Math.abs(d.fuelBefore - pr.fuelAfter) < 10.0
        );
      });

      // Filter B: majority-based raw-readings check.
      // If ≥50% of calibrated readings in the 14 min before the Python-detected
      // rise were already at/near pr.fuelAfter, the fuel was already high and
      // this "rise" is a sensor spike recovery, not a real refuel.
      // Uses a majority threshold (not any single reading) so brief upward sensor
      // noise during a normal refuel approach does not trigger false rejections.
      const preWindowMs = 2 * SPIKE_WINDOW_MINUTES * 60 * 1000;
      const preRiseReadings = readings.filter(
        (r) => r.ts.getTime() < prMs && r.ts.getTime() >= prMs - preWindowMs,
      );
      const highCount = preRiseReadings.filter(
        (r) => r.fuel >= pr.fuelAfter - 5.0,
      ).length;
      const majorityWasHigh = !hasNearbyConfirmedDrop &&
        preRiseReadings.length > 0 &&
        highCount / preRiseReadings.length >= 0.5;

      // Filter C: JS already analyzed and rejected a rise at the same time window.
      // This catches spikes where median-filter dip level ≠ raw dip level (so Guard A
      // misses), and where the spike lasted long enough for Guard B's majority to fail.
      const JS_REJECT_WINDOW_MS = 15 * 60 * 1000;
      const isRejectedByJS = !hasNearbyConfirmedDrop && rejectedRises.some(
        (rt) => Math.abs(rt.getTime() - prMs) < JS_REJECT_WINDOW_MS,
      );

      this.logger.log(
        `[PythonFilter] IMEI ${imei} pr.at=${pr.at} fuelBefore=${pr.fuelBefore} fuelAfter=${pr.fuelAfter} ` +
        `hasNearbyConfirmedDrop=${hasNearbyConfirmedDrop} matchesFakeDrop=${matchesFakeDrop} ` +
        `preRiseReadings=${preRiseReadings.length} highCount=${highCount} majorityWasHigh=${majorityWasHigh} ` +
        `isRejectedByJS=${isRejectedByJS} ` +
        `→ ${(!matchesFakeDrop && !majorityWasHigh && !isRejectedByJS) ? 'KEEP' : 'DISCARD'}`,
      );

      return !matchesFakeDrop && !majorityWasHigh && !isRejectedByJS;
    });
    const refuels = jsRefuels.length > 0 ? jsRefuels : pythonRefuels;
  
    const actualReadings = readings.filter((r) => r.ts >= from);
    const firstFuel = actualReadings.length > 0 ? actualReadings[0].fuel : null;
    const lastFuel  = actualReadings.length > 0 ? actualReadings[actualReadings.length - 1].fuel : null;
  
    const consumed = drops
      .filter((d) => !d.isSensorJump)
      .reduce((sum, d) => sum + d.consumed, 0);
    const refueled = refuels.reduce((sum, r) => sum + r.added, 0);
    const pricePerLiter = this.extractPricePerLiter(fcrJson, from);
  
    const netDrop =
      firstFuel !== null && lastFuel !== null
        ? Math.round((firstFuel - lastFuel) * 100) / 100
        : null;
  
    // Mass-balance: actual fuel burned = (firstFuel + refueled) − lastFuel
    // = max(0, netDrop + refueled).  This is the same formula the Routes page
    // "Period Summary" uses, so cost is consistent with the displayed consumption.
    const actualConsumed =
      netDrop !== null
        ? Math.max(0, netDrop + refueled)
        : consumed;

    const estimatedCost =
      pricePerLiter !== null
        ? Math.round(actualConsumed * pricePerLiter * 100) / 100
        : null;
  
    return {
      imei,
      from: from.toISOString(),
      to: to.toISOString(),
      consumed: Math.round(consumed * 100) / 100,
      refueled: Math.round(refueled * 100) / 100,
      estimatedCost,
      unit: sensor.units || 'L',
      refuelEvents: refuels.length,
      samples: actualReadings.length,
      refuels,
      drops,
      firstFuel: firstFuel !== null ? Math.round(firstFuel * 100) / 100 : null,
      lastFuel:  lastFuel  !== null ? Math.round(lastFuel  * 100) / 100 : null,
      netDrop,
      readings,
    };
  }
  
  private analyzeRows(
    rows: DataRow[],
    sensor: FuelSensor,
    imei: string,
  ): { drops: DropEvent[]; refuels: RefuelEvent[]; firstFuel: number | null; lastFuel: number | null; readings: FuelReading[]; rejectedRises: Date[] } {
    // ── Step 1: transform every row ──────────────────────────────────────────
    const raw: FuelReading[] = [];
    for (const row of rows) {
      const ts = new Date(row.dt_tracker);
      const rawValue = this.transform.extractRawValue(row.params, sensor.param, imei, ts.toISOString());
      if (rawValue === null) continue;
      const { value } = this.transform.transform(rawValue, sensor);
      if (value === null) continue;
      raw.push({ ts, fuel: value, speed: row.speed });
    }

    this.logger.log(
      `[DEBUG] IMEI ${imei} sensor param="${sensor.param}": ${rows.length} rows → ${raw.length} valid readings`,
    );

    // ── Layer 1: Median Filter ────────────────────────────────────────────────
    const transformed = applyMedianFilter(raw, FUEL_MEDIAN_SAMPLES);

    const drops: DropEvent[]   = [];
    const refuels: RefuelEvent[] = [];
    // Timestamps of all rises that JS rejected (fakeRise, recoveryRise, postFallback,
    // isFakeDropRecovery). Used by the Python fallback filter to discard Python-detected
    // rises that JS already analyzed and rejected.
    const rejectedRises: Date[] = [];
    let firstFuel: number | null = null;
    let lastFuel:  number | null = null;
  
    // ── Step 2: index-based walk ──────────────────────────────────────────────
    let i = 0;
    while (i < transformed.length) {
      const { fuel } = transformed[i];
  
      if (firstFuel === null) firstFuel = fuel;
      lastFuel = fuel;
  
      if (i === 0) { i++; continue; }
  
      const prev  = transformed[i - 1];
      const delta = fuel - prev.fuel;
      const singleConsumed = Math.abs(delta);
  
      // ── DROP path ─────────────────────────────────────────────────────────
      if (delta < -NOISE_THRESHOLD) {
        if (singleConsumed >= DROP_ALERT_THRESHOLD) {
          const baselineFuel = prev.fuel;
          const dropTs       = transformed[i].ts;
          const windowEndMs  = dropTs.getTime() + SPIKE_WINDOW_MINUTES * 60 * 1000;
  
          let verifiedFuel = fuel;
          let j = i + 1;
          while (j < transformed.length && transformed[j].ts.getTime() <= windowEndMs) {
            const nextFuel = transformed[j].fuel;
            if (nextFuel > baselineFuel - DROP_ALERT_THRESHOLD) break;
            if (nextFuel - verifiedFuel > REFUEL_THRESHOLD) break;
            verifiedFuel = nextFuel;
            j++;
          }
  
          const totalConsumed = baselineFuel - verifiedFuel;
  
          const verifyPassed    = isDropConfirmedAfterDelay(dropTs, baselineFuel, transformed);
          const fake            = !verifyPassed || isFakeSpike(dropTs, raw, SPIKE_WINDOW_MINUTES, DROP_ALERT_THRESHOLD);
          const postRecovery    = !fake && isPostDropRecovery(dropTs, baselineFuel, raw, SPIKE_WINDOW_MINUTES);
          const isConfirmedDrop = totalConsumed >= DROP_ALERT_THRESHOLD && !fake && !postRecovery;
  
          this.logger.log(
            `[DROP] IMEI ${imei} at ${transformed[i].ts.toISOString()}: ` +
            `baseline=${baselineFuel.toFixed(2)} verified=${verifiedFuel.toFixed(2)} ` +
            `consumed=${totalConsumed.toFixed(2)} verifyPassed=${verifyPassed} fake=${fake} ` +
            `postRecovery=${postRecovery} → confirmed=${isConfirmedDrop}`,
          );
  
          drops.push({
            at:         prev.ts.toISOString(),
            fuelBefore: Math.round(baselineFuel * 100) / 100,
            fuelAfter:  Math.round(verifiedFuel * 100) / 100,
            consumed:   Math.round(totalConsumed * 100) / 100,
            unit:       sensor.units || 'L',
            isSensorJump:    false,
            isConfirmedDrop,
          });
  
          lastFuel = verifiedFuel;
          i = j;
          continue;
  
        } else {
          drops.push({
            at:         prev.ts.toISOString(),
            fuelBefore: Math.round(prev.fuel * 100) / 100,
            fuelAfter:  Math.round(fuel * 100) / 100,
            consumed:   Math.round(singleConsumed * 100) / 100,
            unit:       sensor.units || 'L',
            isSensorJump:    singleConsumed > MAX_SINGLE_READING_DROP,
            isConfirmedDrop: false,
          });
        }
  
      // ── RISE path ─────────────────────────────────────────────────────────
      } else if (delta >= RISE_THRESHOLD) {
        const baselineFuel = prev.fuel;
        const baselineTs   = prev.ts;
        const consolidationEndMs = baselineTs.getTime() + REFUEL_CONSOLIDATION_MINUTES * 60 * 1000;
  
        let peakFuel = fuel;
        let k = i + 1;
        let falledBackInConsolidation = false;
  
        while (k < transformed.length && transformed[k].ts.getTime() <= consolidationEndMs) {
          const nextFuel = transformed[k].fuel;
          if (nextFuel > peakFuel) {
            peakFuel = nextFuel;
          } else if (nextFuel < baselineFuel + RISE_THRESHOLD) {
            // Only flag fake and break if the drop from peak is significant.
            // Minor noise-level dips should not stop peak tracking.
            if (peakFuel - nextFuel > POST_REFUEL_VERIFY_EPS_LITERS) {
              falledBackInConsolidation = true;
              break;
            }
            // else: noise-level dip — keep scanning for true peak
          }
          k++;
        }
  
        const totalAdded = peakFuel - baselineFuel;
  
        if (totalAdded >= RISE_THRESHOLD) {
          if (falledBackInConsolidation) {
            this.logger.warn(
              `[RISE] IMEI ${imei} at ${baselineTs.toISOString()}: ` +
              `FAKE SPIKE — fuel rose ${totalAdded.toFixed(2)}L to peak=${peakFuel.toFixed(2)} ` +
              `but fell back within consolidation window (< baselineFuel + ${RISE_THRESHOLD}L)`,
            );
          }

          // Compute early — used by both sensor-recovery guards and recoveryRise below.
          const recentConfirmedDrop = drops.some(
            (d) =>
              d.isConfirmedDrop &&
              d.at >= new Date(baselineTs.getTime() - 60 * 60 * 1000).toISOString() &&
              d.at <= baselineTs.toISOString(),
          );

          // Guard A: fake-drop-record match — rise baseline ≈ a recorded unconfirmed
          // spike's dip AND peak ≈ its pre-drop level. Catches sparse-data cases
          // where the spike lasts >7 min (outside isFakeSpike window) but the drop
          // record is still in allDrops.
          const isFakeDropRecovery = !recentConfirmedDrop && drops.some((d) => {
            const dropAt = new Date(d.at).getTime();
            return (
              !d.isConfirmedDrop &&
              baselineTs.getTime() - dropAt < 30 * 60 * 1000 &&
              Math.abs(d.fuelAfter  - baselineFuel) < 5.0 &&
              Math.abs(d.fuelBefore - peakFuel)     < 10.0
            );
          });

          if (isFakeDropRecovery) {
            this.logger.log(
              `[RISE] IMEI ${imei} at ${baselineTs.toISOString()}: ` +
              `FAKE DROP RECOVERY — rise ${baselineFuel.toFixed(2)}→${peakFuel.toFixed(2)}L ` +
              `matches recent unconfirmed downward spike, skipping refuel`,
            );
            rejectedRises.push(baselineTs);
            i++;
            continue;
          }

          const fakeRise = falledBackInConsolidation || isFakeRise(baselineTs, transformed);
  
          const recoveryRise =
            !fakeRise &&
            !recentConfirmedDrop &&
            (isRecoveryRise(baselineTs, baselineFuel, peakFuel, transformed) ||
             isStationaryDropRecovery(baselineTs, peakFuel, transformed));
  
          // Anchor postFallback to the actual last scanned reading timestamp,
          // not the theoretical consolidation end which may have no data.
          const actualConsolidationEndTs = transformed[Math.min(k - 1, transformed.length - 1)].ts;
  
          let postFallback =
            !fakeRise &&
            !recoveryRise &&
            isPostRefuelFallback(actualConsolidationEndTs, peakFuel, transformed);

          // Override: if the settled fuel (post-consolidation window) is still well
          // above the pre-refuel baseline, the peak-vs-settled gap is sensor sloshing —
          // not a fake spike. Accept the refuel.
          if (postFallback) {
            const postWinMs    = SPIKE_WINDOW_MINUTES * 60 * 1000;
            const postStart    = new Date(actualConsolidationEndTs.getTime() + postWinMs);
            const postEnd      = new Date(actualConsolidationEndTs.getTime() + 2 * postWinMs);
            const postReadings = transformed.filter((r) => r.ts > postStart && r.ts <= postEnd);
            const settledFuel  = postReadings.length > 0
              ? postReadings[postReadings.length - 1].fuel
              : null;
            // Require ≥75 % of the added fuel to be retained post-consolidation.
            // This accepts real refuels (typically 90–97 % retention) while
            // rejecting post-refuel oscillation noise (typically <70 % retention).
            const retainThreshold = baselineFuel + 0.75 * (peakFuel - baselineFuel);
            if (settledFuel !== null && settledFuel > retainThreshold) {
              this.logger.log(
                `[RISE] IMEI ${imei}: postFallback overridden — ` +
                `settled=${settledFuel.toFixed(2)}L retained=${((settledFuel - baselineFuel) / (peakFuel - baselineFuel) * 100).toFixed(1)}% (≥75%)`,
              );
              postFallback = false;
            }
          }
  
          const movementDuringRefuel =
            !fakeRise &&
            !recoveryRise &&
            !postFallback &&
            this.hasMovementDuringRefuelWindow(baselineTs, actualConsolidationEndTs, raw);
  
          this.logger.log(
            `[RISE] IMEI ${imei} at ${baselineTs.toISOString()}: ` +
            `added=${totalAdded.toFixed(2)}L peak=${peakFuel.toFixed(2)}L ` +
            `fakeRise=${fakeRise} recentConfirmedDrop=${recentConfirmedDrop} ` +
            `recoveryRise=${recoveryRise} postFallback=${postFallback} ` +
            `movementDuringRefuel=${movementDuringRefuel}`,
          );
  
          if (!fakeRise && !recoveryRise && !postFallback) {
            const adjustedRefuel = this.calculateRefuelWindowBounds(
              transformed,
              baselineTs,
              actualConsolidationEndTs,
              baselineFuel,
              peakFuel,
            );
            refuels.push({
              at:         baselineTs.toISOString(),
              fuelBefore: Math.round(adjustedRefuel.fuelBefore * 100) / 100,
              fuelAfter:  Math.round(adjustedRefuel.fuelAfter * 100) / 100,
              added:      Math.round(adjustedRefuel.added * 100) / 100,
              unit:       sensor.units || 'L',
            });
  
            // Confirmed refuel — skip the whole consolidated window.
            lastFuel = transformed[Math.max(i, k - 1)]?.fuel ?? peakFuel;
            i = k;
            continue;
          }
  
          // Rise rejected — record its timestamp so the Python fallback filter
          // can discard any Python-detected rise for the same spike event.
          rejectedRises.push(baselineTs);

          // Rejected rise — do NOT skip to k. Advance one step so each
          // reading in the window gets re-examined individually.
        }
      }

      i++;
    }
  
    return { drops, refuels, firstFuel, lastFuel, readings: raw, rejectedRises };
  }
  private hasMovementDuringRefuelWindow(
    riseAt: Date,
    consolidationEndAt: Date,
    readings: FuelReading[],
  ): boolean {
    // Only check movement DURING the actual refuel window [riseAt, consolidationEndAt].
    // The vehicle driving TO the station (before riseAt) is expected real-world behaviour
    // and must not invalidate the detection. Extending the window before the rise causes
    // virtually every legitimate refuel to be rejected.
    const maxSpeed = readings
      .filter((r) => r.ts >= riseAt && r.ts <= consolidationEndAt)
      .reduce(
        (max, r) =>
          Math.max(
            max,
            typeof r.speed === 'number' && Number.isFinite(r.speed) ? r.speed : 0,
          ),
        0,
      );
    return maxSpeed > REFUEL_MOVEMENT_MAX_SPEED_KMH;
  }

  private calculateRefuelWindowBounds(
    readings: FuelReading[],
    riseAt: Date,
    consolidationEndAt: Date,
    fallbackBefore: number,
    fallbackAfter: number,
  ): { fuelBefore: number; fuelAfter: number; added: number } {
    const windowMs = REFUEL_WINDOW_BOUNDARY_MINUTES * 60 * 1000;
    const beforeStart = new Date(riseAt.getTime() - windowMs);
    const afterEnd = new Date(consolidationEndAt.getTime() + windowMs);

    const beforeWindow = readings
      .filter((r) => r.ts >= beforeStart && r.ts <= riseAt)
      .map((r) => r.fuel);
    const afterWindow = readings
      .filter((r) => r.ts >= consolidationEndAt && r.ts <= afterEnd)
      .map((r) => r.fuel);

    const fuelBefore = beforeWindow.length > 0 ? Math.min(...beforeWindow) : fallbackBefore;
    const afterFromWindow = afterWindow.length > 0 ? Math.max(...afterWindow) : fallbackAfter;
    // Keep at least the consolidation peak so we do not undercount sparse data.
    const fuelAfter = Math.max(afterFromWindow, fallbackAfter);
    const added = Math.max(0, fuelAfter - fuelBefore);

    return { fuelBefore, fuelAfter, added };
  }

  private extractPricePerLiter(fcrJson: string, from: Date): number | null {
    if (!fcrJson || fcrJson === '{}' || fcrJson === '') return null;

    try {
      const parsed: unknown = JSON.parse(fcrJson);

      if (Array.isArray(parsed)) {
        const rates = parsed as Array<{ from: string; pricePerLiter: number }>;
        const sorted = rates
          .filter((r) => new Date(r.from) <= from)
          .sort((a, b) => new Date(b.from).getTime() - new Date(a.from).getTime());
        return sorted[0]?.pricePerLiter ?? null;
      }

      const obj = parsed as FcrConfig;
      const cost = parseFloat(obj.cost ?? '0');
      return cost > 0 ? cost : null;
    } catch {
      this.logger.warn(`Failed to parse FCR JSON: ${fcrJson}`);
      return null;
    }
  }
}
