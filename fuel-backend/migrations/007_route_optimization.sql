-- Route-optimization enhancements: manager settings, deviation remarks,
-- nullable completion photo, persistent assignments. Additive; fd_ prefix;
-- ALTERs guarded for MySQL 8 (no ADD COLUMN IF NOT EXISTS) via a helper proc.

-- 1) Per-manager settings (photo-proof toggle).
CREATE TABLE IF NOT EXISTS fd_manager_settings (
  user_id           INT        NOT NULL,             -- gs_users.id (manager)
  require_bin_photo TINYINT(1) NOT NULL DEFAULT 1,   -- 1 = photo required to complete a bin
  updated_at        DATETIME   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Idempotent ADD COLUMN helper (works on MySQL 8 and MariaDB).
DROP PROCEDURE IF EXISTS fd_add_col;
DELIMITER $$
CREATE PROCEDURE fd_add_col(IN tbl VARCHAR(64), IN col VARCHAR(64), IN ddl VARCHAR(255))
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @s = CONCAT('ALTER TABLE ', tbl, ' ADD COLUMN ', ddl);
    PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
  END IF;
END $$
DELIMITER ;

-- 2) Deviation remarks (operator-entered, distinct from system note).
CALL fd_add_col('fd_route_events', 'remark', 'remark VARCHAR(512) NULL');

-- 3) Persistent assignments.
CALL fd_add_col('fd_assignments', 'persistent', 'persistent TINYINT(1) NOT NULL DEFAULT 0');

-- 4) Completion photo becomes optional (manager may disable the requirement).
--    MODIFY is naturally idempotent — re-running just re-asserts NULL-able.
ALTER TABLE fd_stop_completions MODIFY COLUMN photo_path VARCHAR(512) NULL;

DROP PROCEDURE IF EXISTS fd_add_col;
