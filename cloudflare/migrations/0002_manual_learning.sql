CREATE TABLE learning_live_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  snapshot TEXT NOT NULL
);
CREATE TABLE learning_refresh_guard (
  id INTEGER PRIMARY KEY CHECK(id=1),
  last_started INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  quota_day TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0
);
INSERT INTO learning_refresh_guard(id) VALUES(1);
