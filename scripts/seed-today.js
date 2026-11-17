'use strict';
// Demo mode only: keep "today" alive. Seeded timesheets end on the seed date, so a demo opened a week later shows
// every crew as away. This adds this morning's sign-ins for each branch's field crew (≈88%, a few late, one or two
// on another job) once per local day, after 06:30 branch time. Entries are ordinary open timesheets — the supervisor
// can approve, edit or delete them like any other. Never runs when ROSK_SEED=empty.
const TZ = require('../src/tz');

function pick(rnd, a, b) { return a + rnd() * (b - a); }
function hm(mins) { return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`; }

function seedToday(db, { now = new Date(), log = () => {} } = {}) {
  const branches = db.prepare("SELECT b.*, c.id company_id FROM branches b JOIN companies c ON c.id = b.company_id WHERE b.status = 'live'").all();
  const insTs = db.prepare('INSERT INTO timesheet_entries (user_id, project_id, work_date, start_time, end_time, break_min, hours, ordinary_hours, ot1_hours, ot2_hours, rate_used, cost, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const rateOf = db.prepare('SELECT * FROM wage_rates WHERE company_id = ? AND state = ? AND trade = ? AND classification = ?');
  let added = 0;
  for (const b of branches) {
    const tz = TZ.tzFor(b); const date = TZ.todayIn(tz, now); const hour = TZ.hourIn(tz, now);
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    if (dow === 0 || dow === 6 || hour < 6) continue; // wait for the crews to actually start
    const have = db.prepare(`SELECT COUNT(*) n FROM timesheet_entries t JOIN projects p ON p.id = t.project_id WHERE p.branch_id = ? AND t.work_date = ?`).get(b.id, date).n;
    if (have) continue;
    const crew = db.prepare(`SELECT DISTINCT u.id, u.trade, u.classification, bm.role FROM users u JOIN branch_members bm ON bm.user_id = u.id AND bm.branch_id = ?
      WHERE u.active = 1 AND u.employment_type = 'wages' AND bm.role IN ('field','supervisor')`).all(b.id);
    if (!crew.length) continue;
    let seed = Number(date.replace(/-/g, '')) + b.id; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (const u of crew) {
      const jobs = db.prepare(`SELECT pa.project_id FROM project_access pa JOIN projects p ON p.id = pa.project_id WHERE pa.user_id = ? AND p.branch_id = ? AND p.status = 'live' ORDER BY pa.project_id`).all(u.id, b.id).map(x => x.project_id);
      if (!jobs.length) continue;
      const r = rnd();
      if (u.role === 'field' && r < 0.10) continue;                       // away today
      const job = (u.role === 'supervisor' || r < 0.92) ? jobs[Math.floor(rnd() * jobs.length)] : jobs[0];
      const startMin = 6 * 60 + 30 + Math.round(pick(rnd, 0, 50));          // 06:30–07:20
      const rate = rateOf.get(b.company_id, b.code, u.trade, u.classification) || { base_hourly: 50, ot_1: 1.5, ot_2: 2, daily_allowances: 38.5, oncost_pct: 0.32, ordinary_hours: 7.6 };
      // Still on site (open entry) unless the day is over in that branch
      let endT = null, hours = 0, ord = 0, ot1 = 0, ot2 = 0, cost = 0;
      if (hour >= 16) { hours = Math.round(pick(rnd, 7.6, 8.6) * 4) / 4; ord = Math.min(hours, rate.ordinary_hours); ot1 = Math.min(Math.max(0, hours - ord), 2); ot2 = Math.max(0, hours - ord - ot1);
        endT = hm(startMin + Math.round((hours + 0.5) * 60)); cost = Math.round((ord * rate.base_hourly + ot1 * rate.base_hourly * rate.ot_1 + ot2 * rate.base_hourly * rate.ot_2 + rate.daily_allowances) * (1 + rate.oncost_pct) * 100) / 100; }
      insTs.run(u.id, job, date, hm(startMin), endT, 30, hours, ord, ot1, ot2, rate.base_hourly, cost, 'open', null);
      added++;
    }
    log(`demo: ${date} sign-ins added for ${b.code}`);
  }
  return added;
}

// Check every 20 minutes; cheap (one count per branch) and self-limiting.
function schedule(db, log) {
  const run = () => { try { seedToday(db, { log }); } catch (e) { log('demo top-up failed: ' + e.message); } };
  run(); setInterval(run, 20 * 60 * 1000).unref();
}

module.exports = { seedToday, schedule };
