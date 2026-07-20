-- Switch driver auth from username+password to "driver ID + PIN".
-- The driver logs in with their gs_user_object_drivers.driver_id and a numeric PIN.
-- DESTRUCTIVE: any existing driver logins are dropped and must be re-issued
-- (a PIN per driver). Safe to re-run.
DROP TABLE IF EXISTS fd_driver_credentials;

CREATE TABLE fd_driver_credentials (
  driver_id  INT          NOT NULL,                 -- -> gs_user_object_drivers.driver_id (the login ID)
  user_id    INT          NOT NULL,                 -- owning dispatcher (gs_users.id)
  pin_hash   VARCHAR(255) NOT NULL,                 -- sha256(pin)
  active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (driver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
