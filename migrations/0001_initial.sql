CREATE TABLE usage_daily (
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, day)
);
CREATE TABLE login_attempts (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
