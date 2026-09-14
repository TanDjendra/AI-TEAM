import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgresql://postgres.ulmvmxetvlzrduwamgea:H3radhe997!@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres' });
pool.query("SELECT event_id, event_type, cycle, payload, occurred_at FROM activity_logs WHERE task_id = (SELECT id FROM tasks WHERE external_id = 'TASK-MU1U13IF') ORDER BY occurred_at ASC")
  .then(res => {
    console.log(res.rows.map(r => `${r.occurred_at.toISOString()} | ${r.event_type} | ${JSON.stringify(r.payload)}`).join('\n'));
  })
  .finally(() => pool.end());
