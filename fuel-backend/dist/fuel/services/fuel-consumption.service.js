"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var FuelConsumptionService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.FuelConsumptionService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const fuel_transform_service_1 = require("./fuel-transform.service");
const dynamic_table_query_service_1 = require("./dynamic-table-query.service");
const fuel_drop_filter_util_1 = require("./fuel-drop-filter.util");
const WARMUP_HOURS = 2;
const NOISE_THRESHOLD = 0.5;
const REFUEL_THRESHOLD = 3.0;
const REFUEL_MOVEMENT_MAX_SPEED_KMH = 10.0;
const REFUEL_WINDOW_BOUNDARY_MINUTES = 5;
const MAX_SINGLE_READING_DROP = 2.0;
let FuelConsumptionService = FuelConsumptionService_1 = class FuelConsumptionService {
    transform;
    dynQuery;
    dataSource;
    logger = new common_1.Logger(FuelConsumptionService_1.name);
    constructor(transform, dynQuery, dataSource) {
        this.transform = transform;
        this.dynQuery = dynQuery;
        this.dataSource = dataSource;
    }
    async getPythonAlerts(imei, from, to, unit = 'Liters') {
        try {
            const rows = await this.dataSource.query(`SELECT alert_id, imei, previous_fuel, current_fuel, drop_amount, dt_tracker
         FROM fuel_drop_alerts
         WHERE imei = ? AND dt_tracker BETWEEN ? AND ? AND drop_amount >= ?
         ORDER BY dt_tracker ASC`, [imei, from, to, fuel_drop_filter_util_1.DROP_ALERT_THRESHOLD]);
            const SPIKE_RECOVERY_RATIO = 0.5;
            const SPIKE_RECOVERY_MAX_MS = 30 * 60 * 1000;
            const filtered = rows.filter((r, idx) => {
                const next = rows[idx + 1];
                if (!next)
                    return true;
                const gapMs = new Date(next.dt_tracker).getTime() - new Date(r.dt_tracker).getTime();
                if (gapMs > SPIKE_RECOVERY_MAX_MS)
                    return true;
                const dropMagnitude = r.previous_fuel - r.current_fuel;
                if (dropMagnitude <= 0)
                    return true;
                const recoveryAmount = next.previous_fuel - r.current_fuel;
                const recovered = recoveryAmount / dropMagnitude > SPIKE_RECOVERY_RATIO;
                if (recovered) {
                    this.logger.log(`[DropAlerts] IMEI ${imei} at ${new Date(r.dt_tracker).toISOString()}: ` +
                        `SPIKE RECOVERY — drop ${r.previous_fuel.toFixed(1)}→${r.current_fuel.toFixed(1)}L ` +
                        `(${dropMagnitude.toFixed(1)}L) but next drop starts at ${next.previous_fuel.toFixed(1)}L ` +
                        `(${(recoveryAmount / dropMagnitude * 100).toFixed(0)}% recovery), skipping`);
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
                isConfirmedDrop: true,
            }));
        }
        catch (err) {
            this.logger.warn(`getPythonAlerts error for IMEI ${imei}: ${err}`);
            return [];
        }
    }
    async getPythonRefuels(imei, from, to, unit = 'Liters') {
        try {
            const rows = await this.dataSource.query(`SELECT alert_id, imei, previous_fuel, current_fuel, rise_amount, dt_tracker
         FROM fuel_rise_alerts
         WHERE imei = ? AND dt_tracker BETWEEN ? AND ? AND rise_amount >= ?
         ORDER BY dt_tracker ASC`, [imei, from, to, fuel_drop_filter_util_1.DROP_ALERT_THRESHOLD]);
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
        }
        catch (err) {
            this.logger.warn(`getPythonRefuels error for IMEI ${imei}: ${err}`);
            return [];
        }
    }
    async getConsumption(imei, from, to, sensor, fcrJson) {
        const warmupFrom = new Date(from.getTime() - WARMUP_HOURS * 60 * 60 * 1000);
        const allRows = await this.dynQuery.getRowsInRange(imei, warmupFrom, to);
        this.logger.log(`Consumption for IMEI ${imei}: fetched ${allRows.length} rows (${WARMUP_HOURS}h warmup from ${warmupFrom.toISOString()})`);
        const { drops: allDrops, refuels: allRefuels, readings, rejectedRises } = this.analyzeRows(allRows, sensor, imei);
        const fromIso = from.toISOString();
        const drops = allDrops.filter((d) => d.at >= fromIso);
        const jsRefuels = allRefuels.filter((r) => r.at >= fromIso);
        const rawPythonRefuels = jsRefuels.length === 0
            ? await this.getPythonRefuels(imei, from, to, sensor.units || 'L')
            : [];
        this.logger.log(`[PythonFilter] IMEI ${imei}: jsRefuels=${jsRefuels.length}, rawPythonRefuels=${rawPythonRefuels.length}, from=${from.toISOString()}, to=${to.toISOString()}`);
        const pythonRefuels = rawPythonRefuels.filter((pr) => {
            const prMs = new Date(pr.at).getTime();
            const hasNearbyConfirmedDrop = allDrops.some((d) => d.isConfirmedDrop &&
                Math.abs(new Date(d.at).getTime() - prMs) < 60 * 60 * 1000);
            const matchesFakeDrop = !hasNearbyConfirmedDrop && allDrops.some((d) => {
                if (d.isConfirmedDrop)
                    return false;
                const dropAt = new Date(d.at).getTime();
                return (prMs - dropAt < 30 * 60 * 1000 &&
                    Math.abs(d.fuelAfter - pr.fuelBefore) < 5.0 &&
                    Math.abs(d.fuelBefore - pr.fuelAfter) < 10.0);
            });
            const preWindowMs = 2 * fuel_drop_filter_util_1.SPIKE_WINDOW_MINUTES * 60 * 1000;
            const preRiseReadings = readings.filter((r) => r.ts.getTime() < prMs && r.ts.getTime() >= prMs - preWindowMs);
            const highCount = preRiseReadings.filter((r) => r.fuel >= pr.fuelAfter - 5.0).length;
            const majorityWasHigh = preRiseReadings.length > 0 &&
                highCount / preRiseReadings.length >= 0.5;
            const JS_REJECT_WINDOW_MS = hasNearbyConfirmedDrop
                ? 5 * 60 * 1000
                : 15 * 60 * 1000;
            const isRejectedByJS = rejectedRises.some((rt) => Math.abs(rt.getTime() - prMs) < JS_REJECT_WINDOW_MS);
            const PREDIP_WINDOW_MS = 20 * 60 * 1000;
            const PREDIP_TOLERANCE_L = 5.0;
            let hasPrecedingRawSpike = false;
            const predipReadings = readings.filter((r) => r.ts.getTime() >= prMs - PREDIP_WINDOW_MS && r.ts.getTime() <= prMs);
            for (let ri = 0; ri + 1 < predipReadings.length; ri++) {
                const dipDelta = predipReadings[ri].fuel - predipReadings[ri + 1].fuel;
                if (dipDelta >= fuel_drop_filter_util_1.DROP_ALERT_THRESHOLD) {
                    const levelBeforeDip = predipReadings[ri].fuel;
                    if (Math.abs(pr.fuelAfter - levelBeforeDip) <= PREDIP_TOLERANCE_L) {
                        hasPrecedingRawSpike = true;
                        this.logger.log(`[PythonFilter] IMEI ${imei} pr.at=${pr.at}: PRECEDING RAW SPIKE — ` +
                            `dip ${levelBeforeDip.toFixed(1)}→${predipReadings[ri + 1].fuel.toFixed(1)}L ` +
                            `(${dipDelta.toFixed(1)}L drop), pr.fuelAfter=${pr.fuelAfter.toFixed(1)}L ` +
                            `≈ pre-dip level (within ${PREDIP_TOLERANCE_L}L) → DISCARD`);
                        break;
                    }
                }
            }
            const POST_START_MS = 10 * 60 * 1000;
            const POST_END_MS = 30 * 60 * 1000;
            const sustainThreshold = pr.fuelBefore + 0.5 * (pr.fuelAfter - pr.fuelBefore);
            const postReadings = readings.filter((r) => r.ts.getTime() > prMs + POST_START_MS && r.ts.getTime() <= prMs + POST_END_MS);
            let riseDidNotSustain = false;
            if (postReadings.length >= 3) {
                const minPostFuel = Math.min(...postReadings.map((r) => r.fuel));
                if (minPostFuel < sustainThreshold) {
                    riseDidNotSustain = true;
                    this.logger.log(`[PythonFilter] IMEI ${imei} pr.at=${pr.at}: RISE NOT SUSTAINED — ` +
                        `min post-rise fuel (+10-30min) = ${minPostFuel.toFixed(1)}L < ` +
                        `midpoint ${sustainThreshold.toFixed(1)}L → DISCARD`);
                }
            }
            this.logger.log(`[PythonFilter] IMEI ${imei} pr.at=${pr.at} fuelBefore=${pr.fuelBefore} fuelAfter=${pr.fuelAfter} ` +
                `hasNearbyConfirmedDrop=${hasNearbyConfirmedDrop} matchesFakeDrop=${matchesFakeDrop} ` +
                `preRiseReadings=${preRiseReadings.length} highCount=${highCount} majorityWasHigh=${majorityWasHigh} ` +
                `isRejectedByJS=${isRejectedByJS}(window=${JS_REJECT_WINDOW_MS / 60000}min) hasPrecedingRawSpike=${hasPrecedingRawSpike} ` +
                `riseDidNotSustain=${riseDidNotSustain}(postN=${postReadings.length},threshold=${sustainThreshold.toFixed(1)}L) ` +
                `→ ${(!matchesFakeDrop && !majorityWasHigh && !isRejectedByJS && !hasPrecedingRawSpike && !riseDidNotSustain) ? 'KEEP' : 'DISCARD'}`);
            return !matchesFakeDrop && !majorityWasHigh && !isRejectedByJS && !hasPrecedingRawSpike && !riseDidNotSustain;
        });
        const refuels = jsRefuels.length > 0 ? jsRefuels : pythonRefuels;
        const actualReadings = readings.filter((r) => r.ts >= from);
        const firstFuel = actualReadings.length > 0 ? actualReadings[0].fuel : null;
        const lastFuel = actualReadings.length > 0 ? actualReadings[actualReadings.length - 1].fuel : null;
        const consumed = drops
            .filter((d) => !d.isSensorJump)
            .reduce((sum, d) => sum + d.consumed, 0);
        const refueled = refuels.reduce((sum, r) => sum + r.added, 0);
        const pricePerLiter = this.extractPricePerLiter(fcrJson, from);
        const netDrop = firstFuel !== null && lastFuel !== null
            ? Math.round((firstFuel - lastFuel) * 100) / 100
            : null;
        const actualConsumed = netDrop !== null
            ? Math.max(0, netDrop + refueled)
            : consumed;
        const estimatedCost = pricePerLiter !== null
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
            lastFuel: lastFuel !== null ? Math.round(lastFuel * 100) / 100 : null,
            netDrop,
            readings,
        };
    }
    analyzeRows(rows, sensor, imei) {
        const raw = [];
        for (const row of rows) {
            const ts = new Date(row.dt_tracker);
            const rawValue = this.transform.extractRawValue(row.params, sensor.param, imei, ts.toISOString());
            if (rawValue === null)
                continue;
            const { value } = this.transform.transform(rawValue, sensor);
            if (value === null)
                continue;
            raw.push({ ts, fuel: value, speed: row.speed });
        }
        this.logger.log(`[DEBUG] IMEI ${imei} sensor param="${sensor.param}": ${rows.length} rows → ${raw.length} valid readings`);
        const transformed = (0, fuel_drop_filter_util_1.applyMedianFilter)(raw, fuel_drop_filter_util_1.FUEL_MEDIAN_SAMPLES);
        const drops = [];
        const refuels = [];
        const rejectedRises = [];
        let firstFuel = null;
        let lastFuel = null;
        let i = 0;
        while (i < transformed.length) {
            const { fuel } = transformed[i];
            if (firstFuel === null)
                firstFuel = fuel;
            lastFuel = fuel;
            if (i === 0) {
                i++;
                continue;
            }
            const prev = transformed[i - 1];
            const delta = fuel - prev.fuel;
            const singleConsumed = Math.abs(delta);
            if (delta < -NOISE_THRESHOLD) {
                if (singleConsumed >= fuel_drop_filter_util_1.DROP_ALERT_THRESHOLD) {
                    const baselineFuel = prev.fuel;
                    const dropTs = transformed[i].ts;
                    const windowEndMs = dropTs.getTime() + fuel_drop_filter_util_1.SPIKE_WINDOW_MINUTES * 60 * 1000;
                    let verifiedFuel = fuel;
                    let j = i + 1;
                    while (j < transformed.length && transformed[j].ts.getTime() <= windowEndMs) {
                        const nextFuel = transformed[j].fuel;
                        if (nextFuel > baselineFuel - fuel_drop_filter_util_1.DROP_ALERT_THRESHOLD)
                            break;
                        if (nextFuel - verifiedFuel > REFUEL_THRESHOLD)
                            break;
                        verifiedFuel = nextFuel;
                        j++;
                    }
                    const totalConsumed = baselineFuel - verifiedFuel;
                    const verifyPassed = (0, fuel_drop_filter_util_1.isDropConfirmedAfterDelay)(dropTs, baselineFuel, transformed);
                    const fake = !verifyPassed || (0, fuel_drop_filter_util_1.isFakeSpike)(dropTs, raw, fuel_drop_filter_util_1.SPIKE_WINDOW_MINUTES, fuel_drop_filter_util_1.DROP_ALERT_THRESHOLD);
                    const postRecovery = !fake && (0, fuel_drop_filter_util_1.isPostDropRecovery)(dropTs, baselineFuel, raw, fuel_drop_filter_util_1.SPIKE_WINDOW_MINUTES);
                    const isConfirmedDrop = totalConsumed >= fuel_drop_filter_util_1.DROP_ALERT_THRESHOLD && !fake && !postRecovery;
                    this.logger.log(`[DROP] IMEI ${imei} at ${transformed[i].ts.toISOString()}: ` +
                        `baseline=${baselineFuel.toFixed(2)} verified=${verifiedFuel.toFixed(2)} ` +
                        `consumed=${totalConsumed.toFixed(2)} verifyPassed=${verifyPassed} fake=${fake} ` +
                        `postRecovery=${postRecovery} → confirmed=${isConfirmedDrop}`);
                    drops.push({
                        at: prev.ts.toISOString(),
                        fuelBefore: Math.round(baselineFuel * 100) / 100,
                        fuelAfter: Math.round(verifiedFuel * 100) / 100,
                        consumed: Math.round(totalConsumed * 100) / 100,
                        unit: sensor.units || 'L',
                        isSensorJump: false,
                        isConfirmedDrop,
                    });
                    lastFuel = verifiedFuel;
                    i = j;
                    continue;
                }
                else {
                    drops.push({
                        at: prev.ts.toISOString(),
                        fuelBefore: Math.round(prev.fuel * 100) / 100,
                        fuelAfter: Math.round(fuel * 100) / 100,
                        consumed: Math.round(singleConsumed * 100) / 100,
                        unit: sensor.units || 'L',
                        isSensorJump: singleConsumed > MAX_SINGLE_READING_DROP,
                        isConfirmedDrop: false,
                    });
                }
            }
            else if (delta >= fuel_drop_filter_util_1.RISE_THRESHOLD) {
                const baselineFuel = prev.fuel;
                const baselineTs = prev.ts;
                const consolidationEndMs = baselineTs.getTime() + fuel_drop_filter_util_1.REFUEL_CONSOLIDATION_MINUTES * 60 * 1000;
                let peakFuel = fuel;
                let k = i + 1;
                let falledBackInConsolidation = false;
                while (k < transformed.length && transformed[k].ts.getTime() <= consolidationEndMs) {
                    const nextFuel = transformed[k].fuel;
                    if (nextFuel > peakFuel) {
                        peakFuel = nextFuel;
                    }
                    else if (nextFuel < baselineFuel + fuel_drop_filter_util_1.RISE_THRESHOLD) {
                        if (peakFuel - nextFuel > fuel_drop_filter_util_1.POST_REFUEL_VERIFY_EPS_LITERS) {
                            falledBackInConsolidation = true;
                            break;
                        }
                    }
                    k++;
                }
                const totalAdded = peakFuel - baselineFuel;
                if (totalAdded >= fuel_drop_filter_util_1.RISE_THRESHOLD) {
                    if (falledBackInConsolidation) {
                        this.logger.warn(`[RISE] IMEI ${imei} at ${baselineTs.toISOString()}: ` +
                            `FAKE SPIKE — fuel rose ${totalAdded.toFixed(2)}L to peak=${peakFuel.toFixed(2)} ` +
                            `but fell back within consolidation window (< baselineFuel + ${fuel_drop_filter_util_1.RISE_THRESHOLD}L)`);
                    }
                    const recentConfirmedDrop = drops.some((d) => d.isConfirmedDrop &&
                        d.at >= new Date(baselineTs.getTime() - 60 * 60 * 1000).toISOString() &&
                        d.at <= baselineTs.toISOString());
                    const isFakeDropRecovery = !recentConfirmedDrop && drops.some((d) => {
                        const dropAt = new Date(d.at).getTime();
                        return (!d.isConfirmedDrop &&
                            baselineTs.getTime() - dropAt < 30 * 60 * 1000 &&
                            Math.abs(d.fuelAfter - baselineFuel) < 5.0 &&
                            Math.abs(d.fuelBefore - peakFuel) < 10.0);
                    });
                    if (isFakeDropRecovery) {
                        this.logger.log(`[RISE] IMEI ${imei} at ${baselineTs.toISOString()}: ` +
                            `FAKE DROP RECOVERY — rise ${baselineFuel.toFixed(2)}→${peakFuel.toFixed(2)}L ` +
                            `matches recent unconfirmed downward spike, skipping refuel`);
                        rejectedRises.push(baselineTs);
                        i++;
                        continue;
                    }
                    const fakeRise = falledBackInConsolidation || (0, fuel_drop_filter_util_1.isFakeRise)(baselineTs, transformed);
                    const recoveryRise = !fakeRise &&
                        !recentConfirmedDrop &&
                        ((0, fuel_drop_filter_util_1.isRecoveryRise)(baselineTs, baselineFuel, peakFuel, transformed) ||
                            (0, fuel_drop_filter_util_1.isStationaryDropRecovery)(baselineTs, peakFuel, transformed));
                    const actualConsolidationEndTs = transformed[Math.min(k - 1, transformed.length - 1)].ts;
                    let postFallback = !fakeRise &&
                        !recoveryRise &&
                        (0, fuel_drop_filter_util_1.isPostRefuelFallback)(actualConsolidationEndTs, peakFuel, transformed);
                    if (postFallback) {
                        const postWinMs = fuel_drop_filter_util_1.SPIKE_WINDOW_MINUTES * 60 * 1000;
                        const postStart = new Date(actualConsolidationEndTs.getTime() + postWinMs);
                        const postEnd = new Date(actualConsolidationEndTs.getTime() + 2 * postWinMs);
                        const postReadings = transformed.filter((r) => r.ts > postStart && r.ts <= postEnd);
                        const settledFuel = postReadings.length > 0
                            ? postReadings[postReadings.length - 1].fuel
                            : null;
                        const retainThreshold = baselineFuel + 0.75 * (peakFuel - baselineFuel);
                        if (settledFuel !== null && settledFuel > retainThreshold) {
                            this.logger.log(`[RISE] IMEI ${imei}: postFallback overridden — ` +
                                `settled=${settledFuel.toFixed(2)}L retained=${((settledFuel - baselineFuel) / (peakFuel - baselineFuel) * 100).toFixed(1)}% (≥75%)`);
                            postFallback = false;
                        }
                    }
                    const movementDuringRefuel = !fakeRise &&
                        !recoveryRise &&
                        !postFallback &&
                        this.hasMovementDuringRefuelWindow(baselineTs, actualConsolidationEndTs, raw);
                    this.logger.log(`[RISE] IMEI ${imei} at ${baselineTs.toISOString()}: ` +
                        `added=${totalAdded.toFixed(2)}L peak=${peakFuel.toFixed(2)}L ` +
                        `fakeRise=${fakeRise} recentConfirmedDrop=${recentConfirmedDrop} ` +
                        `recoveryRise=${recoveryRise} postFallback=${postFallback} ` +
                        `movementDuringRefuel=${movementDuringRefuel}`);
                    if (!fakeRise && !recoveryRise && !postFallback) {
                        const adjustedRefuel = this.calculateRefuelWindowBounds(transformed, baselineTs, actualConsolidationEndTs, baselineFuel, peakFuel);
                        refuels.push({
                            at: baselineTs.toISOString(),
                            fuelBefore: Math.round(adjustedRefuel.fuelBefore * 100) / 100,
                            fuelAfter: Math.round(adjustedRefuel.fuelAfter * 100) / 100,
                            added: Math.round(adjustedRefuel.added * 100) / 100,
                            unit: sensor.units || 'L',
                        });
                        lastFuel = transformed[Math.max(i, k - 1)]?.fuel ?? peakFuel;
                        i = k;
                        continue;
                    }
                    rejectedRises.push(baselineTs);
                }
            }
            i++;
        }
        return { drops, refuels, firstFuel, lastFuel, readings: raw, rejectedRises };
    }
    hasMovementDuringRefuelWindow(riseAt, consolidationEndAt, readings) {
        const maxSpeed = readings
            .filter((r) => r.ts >= riseAt && r.ts <= consolidationEndAt)
            .reduce((max, r) => Math.max(max, typeof r.speed === 'number' && Number.isFinite(r.speed) ? r.speed : 0), 0);
        return maxSpeed > REFUEL_MOVEMENT_MAX_SPEED_KMH;
    }
    calculateRefuelWindowBounds(readings, riseAt, consolidationEndAt, fallbackBefore, fallbackAfter) {
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
        const fuelAfter = Math.max(afterFromWindow, fallbackAfter);
        const added = Math.max(0, fuelAfter - fuelBefore);
        return { fuelBefore, fuelAfter, added };
    }
    extractPricePerLiter(fcrJson, from) {
        if (!fcrJson || fcrJson === '{}' || fcrJson === '')
            return null;
        try {
            const parsed = JSON.parse(fcrJson);
            if (Array.isArray(parsed)) {
                const rates = parsed;
                const sorted = rates
                    .filter((r) => new Date(r.from) <= from)
                    .sort((a, b) => new Date(b.from).getTime() - new Date(a.from).getTime());
                return sorted[0]?.pricePerLiter ?? null;
            }
            const obj = parsed;
            const cost = parseFloat(obj.cost ?? '0');
            return cost > 0 ? cost : null;
        }
        catch {
            this.logger.warn(`Failed to parse FCR JSON: ${fcrJson}`);
            return null;
        }
    }
};
exports.FuelConsumptionService = FuelConsumptionService;
exports.FuelConsumptionService = FuelConsumptionService = FuelConsumptionService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(2, (0, typeorm_1.InjectDataSource)()),
    __metadata("design:paramtypes", [fuel_transform_service_1.FuelTransformService,
        dynamic_table_query_service_1.DynamicTableQueryService,
        typeorm_2.DataSource])
], FuelConsumptionService);
//# sourceMappingURL=fuel-consumption.service.js.map