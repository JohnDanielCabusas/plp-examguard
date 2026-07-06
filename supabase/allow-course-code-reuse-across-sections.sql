begin;

-- The previous (owner_admin_id, code) unique index (see allow-duplicate-subject-codes.sql)
-- only allowed a professor to have ONE course per code at all, regardless of year level or
-- section — blocking the legitimate case of offering the same course code to different
-- year/section groups as separate course records. The app already validates this correctly
-- at the application layer (saveSubject() in admin.js blocks only genuinely overlapping
-- code + year level + section combos), so the database no longer needs — and must not
-- enforce — a stricter, code-only uniqueness rule.
drop index if exists public.subjects_owner_admin_id_code_key;

commit;
