-- Driver Android app feature — additive schema (push, phone GPS, proof of delivery).
-- Same conventions as 001_dispatch.sql: `fd_` prefix, no hard FKs to gs_*,
-- loose id coupling, safe to re-run (IF NOT EXISTS).

-- FCM device tokens per driver, so the backend can push job notifications.
-- A driver may sign in on more than one device; token is the unique key.
CREATE TABLE IF NOT EXISTS fd_driver_devices (
  id          INT          NOT NULL AUTO_INCREMENT,
  driver_id   INT          NOT NULL,                 -- -> gs_user_object_drivers.driver_id
  fcm_token   VARCHAR(512) NOT NULL,
  platform    VARCHAR(20)  NOT NULL DEFAULT 'android',
  app_version VARCHAR(20)      NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fd_device_token (fcm_token),
  KEY idx_fd_device_driver (driver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Phone-reported GPS pings while a driver is working an assignment. Supplements
-- the vehicle tracker's GPS (gs_object_data_*) as a location source for the
-- live monitor / deviation analysis.
CREATE TABLE IF NOT EXISTS fd_driver_locations (
  id            BIGINT      NOT NULL AUTO_INCREMENT,
  driver_id     INT         NOT NULL,                -- -> gs_user_object_drivers.driver_id
  assignment_id INT             NULL,                -- -> fd_assignments.assignment_id (active job)
  lat           DECIMAL(10,7) NOT NULL,
  lng           DECIMAL(10,7) NOT NULL,
  speed         FLOAT           NULL,                -- km/h, if device reports it
  accuracy_m    FLOAT           NULL,
  recorded_at   DATETIME    NOT NULL,                -- device timestamp (UTC)
  created_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_fd_loc_assignment (assignment_id, recorded_at),
  KEY idx_fd_loc_driver (driver_id, recorded_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Proof of delivery captured by the driver at a stop (photo + optional note),
-- with the device location at capture time.
CREATE TABLE IF NOT EXISTS fd_pod (
  id            INT          NOT NULL AUTO_INCREMENT,
  assignment_id INT          NOT NULL,               -- -> fd_assignments.assignment_id
  stop_id       INT              NULL,               -- -> fd_route_stops.stop_id (if tied to a stop)
  driver_id     INT          NOT NULL,
  photo_path    VARCHAR(512)     NULL,               -- relative path under UPLOADS_DIR
  note          VARCHAR(1024)    NULL,
  lat           DECIMAL(10,7)    NULL,
  lng           DECIMAL(10,7)    NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_fd_pod_assignment (assignment_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
