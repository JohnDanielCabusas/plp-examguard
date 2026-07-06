begin;

-- Adds the "School Year" field for courses (e.g. "2025-2026"), shown on the
-- course card and course detail page in the professor's Courses tab.
alter table if exists public.subjects add column if not exists school_year text;

commit;
