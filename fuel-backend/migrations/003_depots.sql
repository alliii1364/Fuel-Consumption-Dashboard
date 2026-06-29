-- Depots (yards) + per-route depot anchoring for round-trip routes (yard -> bins -> yard).
-- Additive, fd_-prefixed, idempotent (CREATE TABLE IF NOT EXISTS — no ALTER).

-- A manager's yard/depot. Routes are anchored here as their fixed start & end.
CREATE TABLE IF NOT EXISTS fd_depots (
  depot_id   INT           NOT NULL AUTO_INCREMENT,
  user_id    INT           NOT NULL,            -- gs_users.id (owner)
  name       VARCHAR(150)  NOT NULL,
  lat        DECIMAL(10,7) NOT NULL,
  lng        DECIMAL(10,7) NOT NULL,
  is_default TINYINT(1)    NOT NULL DEFAULT 0,  -- one default per user, used by the builder
  active     TINYINT(1)    NOT NULL DEFAULT 1,
  created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (depot_id),
  KEY idx_fd_depots_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-route depot anchor. Snapshots the depot's name/coords (and references its
-- source depot_id) so the round trip stays renderable even if the yard later
-- moves or is removed. One row per route; absence => a legacy open-path route.
CREATE TABLE IF NOT EXISTS fd_route_depots (
  route_id INT           NOT NULL,              -- fd_routes.route_id
  depot_id INT           NULL,                  -- fd_depots.depot_id (source, may be null if deleted)
  name     VARCHAR(150)  NULL,
  lat      DECIMAL(10,7) NOT NULL,
  lng      DECIMAL(10,7) NOT NULL,
  PRIMARY KEY (route_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
