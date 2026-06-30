-- Dispatch & Route Monitoring feature — additive schema.
-- All tables are prefixed `fd_` (fleet dispatch) and live in the existing `gs` schema.
-- No hard foreign keys to gs_* tables: the platform uses loose, raw-SQL coupling
-- (no ORM entities), so we match that style and reference ids by convention.
-- Safe to re-run: every statement is IF NOT EXISTS.

-- Driver login credentials for the PWA. Identity is REUSED from the existing
-- gs_user_object_drivers registry (46 drivers); this table only adds what that
-- table lacks: a username/password so a driver can authenticate.
CREATE TABLE IF NOT EXISTS fd_driver_credentials (
  driver_id     INT          NOT NULL,                 -- -> gs_user_object_drivers.driver_id
  user_id       INT          NOT NULL,                 -- owning dispatcher (gs_users.id)
  username      VARCHAR(64)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (driver_id),
  UNIQUE KEY uq_fd_driver_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Enriched route plans. Richer than gs_user_routes (which is just a lat,lng
-- polyline string): supports KML provenance, OSRM road geometry, per-route
-- corridor tolerance, and computed distance/duration. May link back to an
-- existing gs_user_routes row via gs_route_id when imported.
CREATE TABLE IF NOT EXISTS fd_routes (
  route_id          INT           NOT NULL AUTO_INCREMENT,
  user_id           INT           NOT NULL,            -- gs_users.id (dispatcher/owner)
  name              VARCHAR(150)  NOT NULL,
  source            VARCHAR(20)   NOT NULL DEFAULT 'manual', -- manual|kml|optimized|imported
  gs_route_id       INT           NULL,                -- gs_user_routes.route_id if imported
  geometry          LONGTEXT      NULL,                -- JSON [[lat,lng], ...] road/plan geometry
  corridor_buffer_m INT           NOT NULL DEFAULT 150,-- deviation tolerance (metres)
  total_distance_km DECIMAL(10,3) NULL,
  total_duration_s  INT           NULL,
  optimized         TINYINT(1)    NOT NULL DEFAULT 0,
  notes             VARCHAR(1024) NULL,
  active            TINYINT(1)    NOT NULL DEFAULT 1,
  created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (route_id),
  KEY idx_fd_routes_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ordered stops/waypoints for a route.
CREATE TABLE IF NOT EXISTS fd_route_stops (
  stop_id   INT           NOT NULL AUTO_INCREMENT,
  route_id  INT           NOT NULL,                    -- fd_routes.route_id
  seq       INT           NOT NULL,
  name      VARCHAR(150)  NULL,
  lat       DECIMAL(10,7) NOT NULL,
  lng       DECIMAL(10,7) NOT NULL,
  type      VARCHAR(20)   NOT NULL DEFAULT 'stop',     -- stop|pickup|dropoff|waypoint|zone
  radius_m  INT           NOT NULL DEFAULT 100,        -- arrival/geofence radius
  PRIMARY KEY (stop_id),
  KEY idx_fd_stops_route (route_id, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A route dispatched to a driver + vehicle. This is what gets monitored live.
CREATE TABLE IF NOT EXISTS fd_assignments (
  assignment_id   INT           NOT NULL AUTO_INCREMENT,
  user_id         INT           NOT NULL,             -- gs_users.id (dispatcher/owner)
  route_id        INT           NOT NULL,             -- fd_routes.route_id
  driver_id       INT           NOT NULL,             -- gs_user_object_drivers.driver_id
  imei            VARCHAR(20)   NOT NULL,             -- gs_objects.imei (vehicle)
  status          VARCHAR(20)   NOT NULL DEFAULT 'assigned', -- assigned|accepted|en_route|arrived|completed|cancelled
  priority        VARCHAR(10)   NOT NULL DEFAULT 'normal',   -- low|normal|high|urgent
  scheduled_start DATETIME      NULL,
  notes           VARCHAR(1024) NULL,
  -- live progress snapshot (updated by the monitoring engine)
  last_lat        DECIMAL(10,7) NULL,
  last_lng        DECIMAL(10,7) NULL,
  last_seen       DATETIME      NULL,
  progress_pct    DECIMAL(5,2)  NULL,
  off_route       TINYINT(1)    NOT NULL DEFAULT 0,
  created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  assigned_at     DATETIME      NULL,
  started_at      DATETIME      NULL,
  completed_at    DATETIME      NULL,
  PRIMARY KEY (assignment_id),
  KEY idx_fd_assign_user (user_id),
  KEY idx_fd_assign_driver (driver_id),
  KEY idx_fd_assign_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only audit trail + alert log for assignments.
CREATE TABLE IF NOT EXISTS fd_route_events (
  event_id      BIGINT        NOT NULL AUTO_INCREMENT,
  assignment_id INT           NOT NULL,               -- fd_assignments.assignment_id
  type          VARCHAR(24)   NOT NULL,               -- status_change|arrived_stop|deviation|missed_stop|location|note
  from_status   VARCHAR(20)   NULL,
  to_status     VARCHAR(20)   NULL,
  stop_id       INT           NULL,
  lat           DECIMAL(10,7) NULL,
  lng           DECIMAL(10,7) NULL,
  distance_m    INT           NULL,                   -- e.g. how far off-corridor
  actor         VARCHAR(12)   NOT NULL DEFAULT 'system', -- manager|driver|system
  note          VARCHAR(512)  NULL,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id),
  KEY idx_fd_events_assign (assignment_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
