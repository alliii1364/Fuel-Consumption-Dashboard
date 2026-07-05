-- Driver-confirmed bin completions (photo + location-verified), one per
-- assignment+stop. Same conventions as 001: fd_ prefix, no hard FKs to gs_*,
-- safe to re-run (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS fd_stop_completions (
  id            INT           NOT NULL AUTO_INCREMENT,
  assignment_id INT           NOT NULL,   -- fd_assignments.assignment_id
  stop_id       INT           NOT NULL,   -- fd_route_stops.stop_id
  driver_id     INT           NOT NULL,   -- gs_user_object_drivers.driver_id
  lat           DECIMAL(10,7) NOT NULL,   -- driver GPS at tap time
  lng           DECIMAL(10,7) NOT NULL,
  accuracy_m    FLOAT             NULL,   -- device-reported GPS accuracy
  distance_m    INT           NOT NULL,   -- computed driver→bin distance
  in_range      TINYINT(1)    NOT NULL,   -- 1 = within radius_m + accuracy allowance
  photo_path    VARCHAR(512)  NOT NULL,   -- required proof photo (under UPLOADS_DIR)
  note          VARCHAR(1024)     NULL,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fd_completion (assignment_id, stop_id),
  KEY idx_fd_completion_assignment (assignment_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
