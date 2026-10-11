CREATE TABLE IF NOT EXISTS manual_adjustments (
  request_id TEXT PRIMARY KEY,
  effective_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delta_minutes INTEGER NOT NULL CHECK(delta_minutes BETWEEN -1440 AND 1440 AND delta_minutes<>0),
  note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=120),
  reversal_of TEXT UNIQUE REFERENCES manual_adjustments(request_id)
);
CREATE INDEX IF NOT EXISTS manual_adjustment_date ON manual_adjustments(effective_date);

