# Fuel Consumption Dashboard

A production-grade fleet fuel management and analytics platform that monitors vehicle fuel consumption in real-time, detects anomalies and theft, calculates efficiency metrics, and generates comprehensive fleet reports.

---

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Backend](#backend)
  - [Modules & Endpoints](#modules--endpoints)
  - [Fuel Analysis Services](#fuel-analysis-services)
  - [Key Algorithms](#key-algorithms)
- [Frontend](#frontend)
  - [Pages & Routes](#pages--routes)
  - [Key Components](#key-components)
- [Database Schema](#database-schema)
- [Business Logic](#business-logic)
- [Security](#security)

---

## Overview

This dashboard connects to a fleet tracking database (MySQL) and provides:

- **Real-time fuel monitoring** per vehicle with calibrated sensor readings
- **Theft & anomaly detection** using a 4-layer median filter and confidence scoring
- **Fleet-level reports**: consumption, refuels, idle waste, high-speed waste, thrift scores, trip analysis
- **Interactive route maps** with trip visualization
- **Cost estimation** based on per-vehicle fuel cost reference (FCR) pricing

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend framework | NestJS 11 |
| Database ORM | TypeORM + MySQL 3.21 |
| Authentication | JWT (Passport.js), 24h expiry |
| Frontend framework | Next.js 16.2 (App Router) |
| UI | React 19, Tailwind CSS 4, Lucide icons |
| Charts | Recharts |
| Maps | Leaflet |
| Export | xlsx (Excel) |

---

## Architecture

```
fuel consumption dashboard/
├── fuel-backend/          # NestJS REST API (port 3007)
│   └── src/
│       ├── auth/          # Login & JWT strategy
│       ├── vehicles/      # Vehicle listing & status
│       ├── fuel/          # Core fuel analysis engine (10 endpoints, 9 services)
│       ├── reports/       # Fleet-level report generation
│       ├── dashboard/     # Summary KPIs & fleet ranking
│       └── common/        # Guards, interceptors, middleware, filters
└── fuel-dashboard/        # Next.js frontend (port 3001)
    └── src/
        ├── app/           # Pages (App Router)
        ├── components/    # 30+ reusable UI components
        ├── lib/           # API client, types, utilities
        ├── contexts/      # Auth context (JWT state)
        └── hooks/         # Custom hooks
```

All API responses follow a standard envelope:
```json
{
  "success": true,
  "message": "Description",
  "data": { }
}
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- MySQL database (connection to `gs` schema with fleet tracking data)

### Backend

```bash
cd fuel-backend
npm install
cp .env.example .env   # Configure your DB credentials and JWT secret
npm run start:dev      # Starts on port 3007
```

### Frontend

```bash
cd fuel-dashboard
npm install
cp .env.local.example .env.local   # Set NEXT_PUBLIC_API_URL
npm run dev            # Starts on port 3001
```

---

## Environment Variables

### Backend (`fuel-backend/.env`)

| Variable | Description | Default |
|----------|-------------|---------|
| `DB_HOST` | MySQL host | `192.168.20.170` |
| `DB_PORT` | MySQL port | `3306` |
| `DB_USER` | Database user | `dev` |
| `DB_PASSWORD` | Database password | — |
| `DB_NAME` | Database name | `gs` |
| `JWT_SECRET` | JWT signing secret | **Change in production** |
| `JWT_EXPIRES_IN` | Token lifetime | `24h` |
| `PORT` | API server port | `3007` |
| `STALE_THRESHOLD_MINUTES` | Minutes before vehicle is "offline" | `30` |

### Frontend (`fuel-dashboard/.env.local`)

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_API_URL` | Backend API base URL (e.g. `http://localhost:3007`) |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Optional, for enhanced map features |

---

## Backend

### Modules & Endpoints

#### Auth — `POST /api/auth/login`

Authenticates users against the `gs_users` table. Supports both legacy MD5 and standard password hashing. Returns a signed JWT on success.

---

#### Vehicles — `GET /api/vehicles`

| Query Param | Description |
|-------------|-------------|
| `hasFuelSensor=true` | Filter to vehicles with a configured fuel sensor |

Returns vehicle list with GPS coordinates, speed, online/offline status, and last-seen timestamp.

---

#### Fuel — `/api/vehicles/:imei/fuel/`

All endpoints are protected by `ImeiOwnershipGuard` (validates the requesting user owns the vehicle).

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sensors` | GET | List all fuel sensors (multi-tank support) |
| `/current` | GET | Latest fuel level; optional `sensorId` param |
| `/history` | GET | Time-series fuel levels; configurable interval (5min, 15min, hour, day) |
| `/consumption` | GET | Cumulative consumed, refueled, net drop, cost estimate |
| `/refuels` | GET | All detected refuel events with timestamps and amounts |
| `/stats` | GET | Full statistics: efficiency, idle drain, timeline events |
| `/thrift` | GET | Thrift score analysis: efficiency, idle, overspeed breakdown |
| `/theft` | GET | Suspicious drop detection and risk classification |
| `/drop-alerts` | GET | Alerts confirmed by the Python monitoring script |
| `/debug` | GET | Raw sensor readings + calibration transformations |

Common query parameters: `from`, `to` (ISO 8601), `tz` (IANA timezone), `sensorId`.

---

#### Reports — `/api/reports/`

Fleet-level reports covering all vehicles owned by the authenticated user.

| Endpoint | Description |
|----------|-------------|
| `/consumption` | Per-vehicle and fleet total fuel consumed, refueled, and cost |
| `/refuels` | All refuel events across the fleet |
| `/idle-waste` | Fuel drained while engine is ON and speed < 2 km/h |
| `/high-speed` | Fuel wasted above 100 km/h |
| `/daily-trend` | Per-day consumption, distance, efficiency |
| `/thrift` | Per-vehicle thrift score leaderboard |
| `/engine-hours` | Engine runtime derived from ignition signal |
| `/vehicle-status` | Real-time snapshot: online/offline, fuel level, GPS |
| `/theft` | Fleet-wide theft risk summary |
| `/trips` | Per-vehicle trip breakdown with efficiency metrics |

All report endpoints accept `from` and `to` query parameters (ISO 8601).

---

#### Dashboard — `/api/dashboard/`

| Endpoint | Description |
|----------|-------------|
| `/summary` | Fleet KPIs: total consumed, cost, per-vehicle summary |
| `/fleet-ranking` | Efficiency leaderboard with thrift scores |

---

### Fuel Analysis Services

| Service | Responsibility |
|---------|---------------|
| `FuelSensorResolverService` | Resolves sensor config, calibration curves, multi-tank |
| `FuelTransformService` | Applies calibration formulas to raw sensor readings |
| `FuelConsumptionService` | Drop/refuel detection using 4-layer median filter |
| `FuelHistoryService` | Time-series bucketing with timezone support |
| `FuelStatsService` | Efficiency metrics, idle drain, timeline events |
| `ThriftService` | Calculates thrift score (0–100) |
| `TheftDetectionService` | Classifies drops: normal / suspicious / theft |
| `TripAnalyzerService` | Trip segmentation from ignition transitions |
| `FuelAnomalyMiddleware` | Detects fake refuel spikes (sensor glitches vs real refuels) |

---

### Key Algorithms

#### 4-Layer Fuel Drop Filter

Applied in `FuelConsumptionService` to separate real drops from sensor noise:

1. **Causal Median Filter** — Smooths noise using a 5-sample rolling window
2. **Fake Spike Detection** — Drops ≥ 8 L that recover within 7 min are discarded as glitches
3. **Post-Drop Verification** — Confirms the drop stayed low after the spike window
4. **Sensor Jump Filter** — Single-reading drops > 2 L are treated as sensor glitches

Key thresholds:
- `DROP_ALERT_THRESHOLD` = 8 L — Minimum drop worth investigating
- `THEFT_DROP_LITERS` = 15 L — Threshold for theft classification
- `SPIKE_WINDOW_MINUTES` = 7 — Analysis window for fake spike detection
- `FUEL_MEDIAN_SAMPLES` = 5 — Median filter window size

#### Thrift Score (0–100)

Calculated in `ThriftService`, penalizing three behaviors:
- **Efficiency:** km/L below the vehicle's ideal ratio
- **Idle drain:** Fuel consumed while speed < 2 km/h with engine on
- **Overspeed:** Fuel consumed above 100 km/h

Ratings: Excellent (> 85) | Good (70–85) | Average (50–70) | Poor (< 50)

#### Theft Classification

Each confirmed drop is classified by `TheftDetectionService`:
- **Normal** — < 8 L or single-reading spike
- **Suspicious** — 8–15 L, confirmed by filter, rapid (< 5 min), vehicle stationary
- **Theft** — > 15 L, confirmed, stationary, rapid

A risk score is then calculated from drop frequency, severity, and patterns.

#### Refuel Anomaly Detection (`FuelAnomalyMiddleware`)

Detects questionable refuel events with confidence scores:

| Pattern | Confidence |
|---------|-----------|
| Fuel rose then fell within 7–14 min (fake spike) | 85% |
| Dip-then-recover (sensor reset) | 90% |
| Fuel level didn't stay elevated 15+ min | 80% |
| Vehicle was moving > 10 km/h during refuel window | 75% |
| Vehicle never stopped during the window | 65% |

Each refuel in the API response includes an `_anomaly` metadata field when detected.

#### Trip Detection (`TripAnalyzerService`)

- Segments trips on ignition ON/OFF transitions
- Calculates distance using the Haversine formula
- Minimum valid trip: 5 min duration, 500 m distance, 5 km/h average speed

#### Fuel Consumption Calculation

```
netDrop = firstFuel - lastFuel
consumed = sum of confirmed drops
refueled = sum of confirmed refuel events
cost = consumed × pricePerLiter  (from vehicle FCR JSON, date-range aware)
```

A 2-hour warmup period before the `from` date is used to pre-seed the median filter.

---

## Frontend

### Pages & Routes

| Route | Page | Description |
|-------|------|-------------|
| `/login` | LoginPage | JWT authentication |
| `/` | DashboardPage | Main view: vehicle list, fuel history chart, alerts, stats |
| `/routes` | RoutesPage | Trip mapping with Leaflet, inline calendar, route visualization |
| `/theft` | TheftDetectionPage | Fleet theft risk analysis, drop classification |
| `/analytics` | AnalyticsPage | Cost projections, efficiency benchmarks, theft trends |
| `/reports` | ReportsPage | Generate and export fleet reports (consumption, refuels, thrift, trips) |

### Key Components

| Component | Purpose |
|-----------|---------|
| `VehicleTable` | Vehicle list with online/offline indicators |
| `FuelTrendChart` | Time-series line chart (Recharts) |
| `TheftAlerts` | Real-time theft detection alerts |
| `RouteMap` | Leaflet map with trip polylines |
| `KpiCards` | Fleet-wide metric summary cards |
| `DateRangePicker` | ISO date range selection |
| `RiskScoreGauge` | Circular theft risk visualization |
| `Heatmap` | Vehicle efficiency comparison heatmap |
| `ComparisonCard` | Period-over-period analysis |

### Key Utilities (`src/lib/`)

| File | Purpose |
|------|---------|
| `api.ts` | Axios API client with JWT injection and retry logic |
| `types.ts` | TypeScript interfaces for all API responses |
| `dateUtils.ts` | Date manipulation and formatting helpers |
| `export.ts` | Excel report export using the `xlsx` library |
| `fuelDetection.ts` | Client-side fuel analysis helpers |
| `fuelAnomalyUtils.ts` | Client-side anomaly detection utilities |

---

## Database Schema

The backend reads from a MySQL database (`gs` schema) shared with an existing fleet tracking system:

| Table | Description |
|-------|-------------|
| `gs_users` | User accounts (MD5 password support) |
| `gs_user_objects` | User-to-vehicle assignments (access control) |
| `gs_objects` | Vehicles: FCR pricing JSON, GPS coords, speed |
| `gs_object_sensors` | Fuel sensor configs with calibration curve data |
| `imei_{number}_dt_tracker` | Per-vehicle sensor readings (dynamic table names) |
| `fuel_drop_alerts` | Confirmed drop alerts written by Python monitoring script |

---

## Business Logic

### Fuel Cost Reference (FCR)

Each vehicle in `gs_objects` stores a `fuelCostReference` JSON array with date-range based fuel pricing. The cost for a date range is calculated by matching consumed fuel to the applicable price period.

### Multi-Tank Support

Vehicles can have multiple fuel sensors. The `/sensors` endpoint lists all configured tanks. Most fuel endpoints accept an optional `sensorId` to query a specific tank, or return aggregated data when omitted.

### Online/Offline Status

A vehicle is considered **offline** if no sensor data has been received within `STALE_THRESHOLD_MINUTES` (default: 30 minutes).

### Python Integration

A separate Python monitoring script (`aysis-latest.py`) reads sensor data and writes confirmed fuel drop alerts to the `fuel_drop_alerts` table. The `/drop-alerts` endpoint surfaces these for cross-validation against the NestJS detection engine.

---

## Security

- All endpoints (except `POST /api/auth/login`) require a valid `Authorization: Bearer <token>` header.
- `ImeiOwnershipGuard` verifies that the requesting user owns the vehicle via the `gs_user_objects` join before processing any fuel or vehicle endpoint.
- CORS is enabled on the backend for cross-origin frontend requests.
- All incoming DTOs are validated with `class-validator` enforcing ISO 8601 dates and typed parameters.
