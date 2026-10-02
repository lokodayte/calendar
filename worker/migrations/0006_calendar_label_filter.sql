-- Hide events by label (ICS CATEGORIES) per shared calendar, e.g. ["Operations"] on the public club calendar.
-- JSON array of label names; '[]' shows everything.
ALTER TABLE calendars ADD COLUMN hide_labels TEXT NOT NULL DEFAULT '[]';
