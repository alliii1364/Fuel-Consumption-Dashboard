-- Daily fuel rollup — precomputed per-vehicle per-day metrics for fast dashboard reads.
-- Strictly additive: a brand-new fd_-prefixed table. NO changes to any gs_* table.
CREATE TABLE IF NOT EXISTS fd_fuel_daily (
  imei          VARCHAR(32)   NOT NULL,            -- gs_objects.imei
  sensor_id     INT           NOT NULL,            -- gs_object_sensors sensor id
  day           DATE          NOT NULL,            -- Asia/Karachi calendar day
  consumed      DOUBLE        NOT NULL DEFAULT 0,  -- drop-sum for the day (L)
  refueled      DOUBLE        NOT NULL DEFAULT 0,  -- refuel total for the day (L)
  net_drop      DOUBLE            NULL,            -- firstFuel - lastFuel for the day
  first_fuel    DOUBLE            NULL,            -- fuel level at day start
  last_fuel     DOUBLE            NULL,            -- fuel level at day end
  first_ts      DATETIME          NULL,            -- first reading ts that day (UTC)
  last_ts       DATETIME          NULL,            -- last reading ts that day (UTC)
  cost          DOUBLE            NULL,            -- estimated cost for the day
  refuel_events JSON              NULL,            -- [{at,fuelBefore,fuelAfter,added,unit}]
  samples       INT           NOT NULL DEFAULT 0,  -- rows analysed that day
  computed_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (imei, sensor_id, day),
  KEY idx_fd_fuel_daily_imei_day (imei, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
