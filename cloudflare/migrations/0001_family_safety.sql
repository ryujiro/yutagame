CREATE TABLE IF NOT EXISTS learning_days (
  date TEXT PRIMARY KEY,
  total_minutes INTEGER NOT NULL CHECK(total_minutes >= 0),
  fetched_at TEXT NOT NULL,
  subjects_json TEXT
);
CREATE TABLE IF NOT EXISTS grant_events (
  event_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  allow_until TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL,
  detection_method TEXT NOT NULL,
  estimated_minutes INTEGER,
  granted_minutes INTEGER,
  confirmation_status TEXT NOT NULL DEFAULT 'needs_review',
  received_at TEXT NOT NULL,
  CHECK(confirmation_status IN ('needs_review', 'confirmed')),
  CHECK((confirmation_status = 'needs_review' AND granted_minutes IS NULL) OR
        (confirmation_status = 'confirmed' AND granted_minutes > 0))
);
CREATE INDEX IF NOT EXISTS grant_events_time ON grant_events(occurred_at);
CREATE TABLE IF NOT EXISTS grant_confirmations (
  event_id TEXT PRIMARY KEY REFERENCES grant_events(event_id),
  granted_minutes INTEGER NOT NULL CHECK(granted_minutes > 0),
  confirmed_at TEXT NOT NULL,
  method TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bridge_status (
  source_id TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL,
  read_status TEXT NOT NULL CHECK(read_status IN ('ok', 'error')),
  coverage_start TEXT,
  local_used_minutes INTEGER
);
