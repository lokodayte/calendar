-- Event suggestions from signed-in people, reviewed by admins.
-- After a decision, the details and the attached file are deleted at once; only a one-line
-- receipt (title, date, decision, note) stays for the person who suggested it, for 30 days.
CREATE TABLE suggestions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT NOT NULL,
  title        TEXT NOT NULL,
  date         TEXT NOT NULL,              -- YYYY-MM-DD (Eastern Time)
  all_day      INTEGER NOT NULL DEFAULT 0,
  start_time   TEXT,                       -- HH:MM
  end_time     TEXT,
  location     TEXT NOT NULL DEFAULT '',
  host         TEXT NOT NULL DEFAULT '',
  details      TEXT NOT NULL DEFAULT '',
  link         TEXT NOT NULL DEFAULT '',
  calendar_id  INTEGER,                    -- which shared calendar it should go on (optional)
  file_name    TEXT,
  file_type    TEXT,
  file_size    INTEGER,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | added | rejected
  note         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  decided_by   TEXT
);
CREATE INDEX suggestions_status ON suggestions(status, created_at);
CREATE INDEX suggestions_email ON suggestions(email, created_at);

-- Attachments live in their own table so lists never read them. data is a data: URL made by the browser.
CREATE TABLE suggestion_files (
  suggestion_id  INTEGER PRIMARY KEY,
  data           TEXT NOT NULL
);
