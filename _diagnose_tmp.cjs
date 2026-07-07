require('dotenv').config({ path: require('path').join(__dirname, '.env.local') });
const { query } = require('./server/db.cjs');

(async () => {
  try {
    const professors = await query('select id, username, name, email, created_at from public.professors order by created_at nulls first, id');
    console.log('--- professors ---');
    professors.rows.forEach(r => console.log(JSON.stringify(r)));

    const subjOwners = await query('select owner_admin_id, count(*) from public.subjects group by owner_admin_id');
    console.log('--- subjects by owner_admin_id ---');
    subjOwners.rows.forEach(r => console.log(JSON.stringify(r)));

    const examOwners = await query('select owner_admin_id, count(*) from public.exams group by owner_admin_id');
    console.log('--- exams by owner_admin_id ---');
    examOwners.rows.forEach(r => console.log(JSON.stringify(r)));

    const studentOwners = await query('select owner_admin_id, count(*) from public.students group by owner_admin_id');
    console.log('--- students by owner_admin_id ---');
    studentOwners.rows.forEach(r => console.log(JSON.stringify(r)));
  } catch (error) {
    console.error('DIAGNOSTIC ERROR:', error.message || error);
  } finally {
    process.exit(0);
  }
})();
