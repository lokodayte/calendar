-- Desk coverage was removed from the app: drop its setting and the "shift calendar" flag.
DELETE FROM settings WHERE key = 'coverage';
ALTER TABLE calendars DROP COLUMN is_shift;
