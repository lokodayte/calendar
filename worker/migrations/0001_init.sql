-- SCSM Calendar: initial schema. All times are Unix milliseconds unless noted.

-- People allowed to sign in. Admins (ADMIN_EMAILS) can always sign in and are
-- added here automatically on their first sign-in.
CREATE TABLE staff (
  email         TEXT PRIMARY KEY,
  added_at      INTEGER NOT NULL,
  added_by      TEXT,
  last_sign_in  INTEGER
);

-- One row per signed-in device. id = HMAC of the device token (the token itself is never stored).
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  device      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_email ON sessions(email);

-- Pending email codes (hashed) and the per-email hourly limit.
CREATE TABLE login_codes (
  email         TEXT PRIMARY KEY,
  code_hash     TEXT NOT NULL,
  tries         INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER NOT NULL,
  window_start  INTEGER NOT NULL,
  window_count  INTEGER NOT NULL
);

-- Shared calendars, managed by admins. url never leaves the server except to admins.
CREATE TABLE calendars (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL,
  url         TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'other',   -- outlook | google | apple | other
  owner       TEXT NOT NULL DEFAULT '',
  default_on  INTEGER NOT NULL DEFAULT 1,
  is_shift    INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Last good copy of each ICS feed (gzip), so a source outage doesn't blank the calendar.
-- key = 'shared:<id>' or 'mine:<id>'. url_hash detects a changed link.
CREATE TABLE feed_cache (
  key          TEXT PRIMARY KEY,
  url_hash     TEXT NOT NULL,
  body         BLOB,
  fetched_at   INTEGER NOT NULL,
  checked_at   INTEGER NOT NULL,
  last_error   TEXT
);

-- Per-person on/off choices: {"shared:3": false, "mine": true, "feed:5": true}
CREATE TABLE user_prefs (
  email       TEXT PRIMARY KEY,
  visible     TEXT NOT NULL DEFAULT '{}',
  updated_at  INTEGER NOT NULL
);

-- Personal events. Dates/times are wall-clock in America/New_York.
CREATE TABLE personal_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL,
  title         TEXT NOT NULL,
  date          TEXT NOT NULL,             -- YYYY-MM-DD
  all_day       INTEGER NOT NULL DEFAULT 0,
  start_time    TEXT,                      -- HH:MM
  end_time      TEXT,                      -- HH:MM
  location      TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  repeat_weekly INTEGER NOT NULL DEFAULT 0,
  repeat_until  TEXT,                      -- YYYY-MM-DD
  color         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX personal_events_email ON personal_events(email);

-- Personal calendar links (ICS) that only their owner sees.
CREATE TABLE personal_feeds (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL,
  url         TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'other',
  created_at  INTEGER NOT NULL
);
CREATE INDEX personal_feeds_email ON personal_feeds(email);

-- Site-wide settings as JSON values (site_title, sender_name, coverage).
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- What admins changed, and when.
CREATE TABLE admin_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  detail  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX admin_log_at ON admin_log(at);
