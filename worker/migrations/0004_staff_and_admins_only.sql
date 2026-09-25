-- Simplify: people are either admins or staff (no student assistants, no end dates),
-- and a shared calendar is either public or staff only.
UPDATE staff SET role = 'staff' WHERE role NOT IN ('admin', 'staff');
ALTER TABLE staff DROP COLUMN access_until;
UPDATE calendars SET audience = 'staff' WHERE audience <> 'public';
