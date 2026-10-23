-- One row per endpoint the app registered: the APNs device token (it never leaves the relay), the
-- APNs environment the token belongs to, the first VAPID key that pushed to the endpoint (NULL
-- until one did) and the current rate window (its start, in Unix seconds, and the pushes in it).
-- No address, no time of registration, nothing of what a push said. A token may hold several
-- endpoints, one per PC; the newest ENDPOINTS_PER_TOKEN (worker.ts) are kept.
CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  vapid_key TEXT,
  window_start INTEGER NOT NULL DEFAULT 0,
  window_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS endpoints_token ON endpoints (token);
