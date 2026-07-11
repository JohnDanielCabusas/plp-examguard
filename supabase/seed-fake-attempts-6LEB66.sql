-- =====================================================================
-- Seed script: fake exam attempts for testing the exam with code 6LEB66
-- =====================================================================
-- Inserts 30 fake "sessions" rows (exam attempts) so you can preview
-- what the professor dashboard / Statistics / Reports / Review screens
-- look like with a realistic number of students:
--   * each student gets a real per-question answer (correct or wrong,
--     matching the exam's actual questions/options), so the "Review"
--     modal shows a proper right/wrong breakdown per question
--   * score/max_score are derived from those per-question answers
--     (not random), so they stay internally consistent
--   * warnings vary: 6 students get 4-9 warnings (>3), the rest get
--     0-2 (<3) - every warning has a matching row in `logs` AND a
--     matching entry in `sessions.activities`, so the warning count
--     shown in the UI always matches the number of activity entries
--
-- SAFE TO DELETE: every row this script creates uses the id prefix
-- 'seed-6leb66-' (sessions + logs) and student_id prefix 'SEED-'. See
-- the CLEANUP section at the bottom of this file to remove them again.
--
-- Requires: an exam already exists with code = '6LEB66'. Run this in
-- the Supabase SQL editor (executes as postgres, so RLS is bypassed).
-- Safe to re-run: ids are deterministic and inserts use ON CONFLICT DO
-- NOTHING, so re-running without cleaning up first just skips rows
-- that already exist (it will NOT refresh them with new random data -
-- run the CLEANUP section first if you want a fresh batch).
-- =====================================================================

begin;

do $$
declare
  v_exam_id   text;
  v_owner     text;
  v_questions jsonb;
  v_max_score int;

  n           int;
  q           jsonb;
  q_id        text;
  q_type      text;
  q_points    int;
  is_correct  boolean;
  ans_value   text;
  wrong_opt   text;

  student_answers jsonb;
  student_score   int;
  ability         numeric;
  warn_count      int;

  sess_id  text;
  stu_id   text;
  stu_name text;
  start_ts timestamptz;
  end_ts   timestamptz;

  activities   jsonb;
  k            int;
  chosen_type  text;
  chosen_detail text;
  log_ts       timestamptz;

  strike_types text[] := array['fullscreen_exit','window_blur','tab_switch','screenshot','no_person','low_brightness'];
  strike_details jsonb := jsonb_build_object(
    'fullscreen_exit', 'Fullscreen mode exited',
    'window_blur',     'Another application was opened',
    'tab_switch',       'Tab or window switched',
    'screenshot',       'PrintScreen key pressed - possible screenshot attempt',
    'no_person',        'No person detected in camera frame',
    'low_brightness',   'Room too dark - professor cannot clearly see the student on camera'
  );

  first_names text[] := array['Maria','Juan','Angela','Mark','Kristine','Paolo','Nicole','Carlo','Bea','Josef',
                               'Trisha','Miguel','Alyssa','Rafael','Camille','Dominic','Erika','Gabriel','Hannah','Ivan',
                               'Jasmine','Kevin','Louise','Nathaniel','Olivia','Patrick','Queenie','Renz','Samantha','Tomas'];
  last_names  text[] := array['Santos','Dela Cruz','Reyes','Villanueva','Bautista','Garcia','Mendoza','Torres','Ramos','Aquino',
                               'Fernandez','Castillo','Navarro','Gonzales','Pascual','Flores','Salazar','Marquez','Cruz','Domingo',
                               'Rivera','Lopez','Ocampo','Serrano','Trinidad','Manalo','Alcantara','Bernardo','Cabrera','De Guzman'];
  year_levels text[] := array['1st Year','2nd Year','3rd Year','4th Year'];
  sections    text[] := array['A','B','C'];
begin
  select id, owner_admin_id, questions
  into v_exam_id, v_owner, v_questions
  from public.exams
  where code = '6LEB66'
  limit 1;

  if v_exam_id is null then
    raise exception 'No exam found with code 6LEB66 - create/publish that exam first, then rerun this script.';
  end if;

  select coalesce(sum((qq ->> 'points')::int), 25)
  into v_max_score
  from jsonb_array_elements(v_questions) qq;

  for n in 1..30 loop
    sess_id  := 'seed-6leb66-' || lpad(n::text, 3, '0');
    stu_id   := 'SEED-' || lpad(n::text, 4, '0');
    stu_name := first_names[n] || ' ' || last_names[n];

    -- every 5th student racked up 4-9 warnings (>3); everyone else stays at 0-2 (<3)
    warn_count := case when n % 5 = 0 then 4 + (n % 6) else (n % 3) end;

    start_ts := now() - make_interval(mins => 90 - (n % 60));
    end_ts   := start_ts + interval '25 minutes';

    -- per-student ability so scores vary realistically (~30%-95% correctness)
    ability := 0.3 + random() * 0.65;

    student_answers := '{}'::jsonb;
    student_score   := 0;

    for q in select * from jsonb_array_elements(v_questions) loop
      q_id     := q ->> 'id';
      q_type   := coalesce(q ->> 'type', 'mcq');
      q_points := coalesce((q ->> 'points')::int, 1);
      is_correct := random() < ability;

      if q_type = 'mcq' then
        if is_correct then
          ans_value := q ->> 'correctAnswer';
        else
          select opt into wrong_opt
          from jsonb_array_elements_text(q -> 'options') opt
          where opt <> (q ->> 'correctAnswer')
          order by random()
          limit 1;
          ans_value := coalesce(wrong_opt, 'N/A');
        end if;

      elsif q_type = 'tf' then
        if is_correct then
          ans_value := q ->> 'correctAnswer';
        else
          ans_value := case when (q ->> 'correctAnswer') = 'True' then 'False' else 'True' end;
        end if;

      elsif q_type = 'identification' then
        if is_correct then
          ans_value := q ->> 'correctAnswer';
        else
          ans_value := 'N/A';
        end if;

      else
        -- fallback for any other question type (essay/coding/etc.)
        ans_value := case when is_correct then coalesce(q ->> 'correctAnswer', '') else '' end;
      end if;

      if is_correct then
        student_score := student_score + q_points;
      end if;

      student_answers := student_answers || jsonb_build_object(q_id, ans_value);
    end loop;

    -- build matching proctoring "warning" activities + logs, spread across the attempt
    activities := '[]'::jsonb;
    for k in 1..warn_count loop
      chosen_type   := strike_types[1 + floor(random() * array_length(strike_types, 1))::int];
      chosen_detail := strike_details ->> chosen_type;
      log_ts := start_ts + (end_ts - start_ts) * (k::float8 / (warn_count + 1)::float8);

      activities := activities || jsonb_build_object(
        'type', chosen_type,
        'detail', chosen_detail,
        'timestamp', to_char(log_ts, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      );

      insert into public.logs (
        id, session_id, student_id, exam_id, type, details, timestamp, owner_admin_id
      ) values (
        sess_id || '-log-' || k, sess_id, stu_id, v_exam_id, chosen_type, chosen_detail, log_ts, v_owner
      )
      on conflict (id) do nothing;
    end loop;

    insert into public.sessions (
      id, exam_id, exam_code, student_id, student_name,
      year_level, section, year_section, department, program,
      start_time, end_time, answers, warnings, activities,
      score, max_score, submitted, auto_submitted, score_released,
      ai_detections, camera_snapshots, owner_admin_id, created_at
    ) values (
      sess_id, v_exam_id, '6LEB66', stu_id, stu_name,
      year_levels[1 + (n % 4)], sections[1 + (n % 3)],
      year_levels[1 + (n % 4)] || ' - ' || sections[1 + (n % 3)],
      'BS Computer Science', 'BSCS',
      start_ts, end_ts, student_answers, warn_count, activities,
      student_score, v_max_score, true, (warn_count > 3), true,
      '{}'::jsonb, '[]'::jsonb, v_owner, start_ts
    )
    on conflict (id) do nothing;
  end loop;

  raise notice 'Seeded 30 fake sessions for exam 6LEB66 (max_score=%).', v_max_score;
end $$;

commit;

-- =====================================================================
-- CLEANUP: run this whenever you're done testing to remove all
-- fake rows this script created. Uncomment and run in the SQL editor.
-- (logs are deleted first since they reference the seeded sessions)
-- =====================================================================
-- delete from public.logs     where session_id like 'seed-6leb66-%' or student_id like 'SEED-%';
-- delete from public.sessions where id like 'seed-6leb66-%' or student_id like 'SEED-%';
