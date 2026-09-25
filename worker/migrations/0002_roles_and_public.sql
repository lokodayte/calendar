-- Roles for people on the list, and who can see each shared calendar.

-- role: 'admin' | 'staff' | 'assistant'. Super admins are set in wrangler.toml (SUPERADMIN_EMAILS), not here.
ALTER TABLE staff ADD COLUMN role TEXT NOT NULL DEFAULT 'staff';
ALTER TABLE staff ADD COLUMN name TEXT NOT NULL DEFAULT '';
-- Last day of access (YYYY-MM-DD, Eastern Time), e.g. the end of a student assistant's semester. NULL = no end.
ALTER TABLE staff ADD COLUMN access_until TEXT;

-- audience: 'public' (anyone, on the front page) | 'everyone' (all signed-in people) | 'staff' (not student assistants)
ALTER TABLE calendars ADD COLUMN audience TEXT NOT NULL DEFAULT 'everyone';
