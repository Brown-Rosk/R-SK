'use strict';
// Staff records, wage-rate tables (per state × trade × classification), timesheets with clock in/out,
// weekly approval, and labour cost flowing into each job's labour cost codes.
const { HttpError } = require('../http');
const A = require('../auth');

const TRADES = ['Fire', 'Mechanical', 'Electrical', 'Hydraulic', 'Office'];
const EMPLOYMENT = ['wages', 'salary', 'contractor'];
const LABOUR_CODE = { fire: '20', mechanical: '20', electrical: '20', hydraulic: '20' }; // labour cost code per discipline (branch templates use 20/30)

function stateOf(ctx, branchId) { return ctx.db.prepare('SELECT code FROM branches WHERE id = ?').get(branchId)?.code; }

function rateFor(db, companyId, state, trade, classification) {
  return db.prepare('SELECT * FROM wage_rates WHERE company_id = ? AND state = ? AND trade = ? AND classification = ?').get(companyId, state, trade, classification)
    || db.prepare('SELECT * FROM wage_rates WHERE company_id = ? AND state = ? AND trade = ? ORDER BY base_hourly LIMIT 1').get(companyId, state, trade)
    || null;
}

// Split a day's hours into ordinary / OT1 / OT2 and cost them. Salaried staff: hourly equivalent of salary (52 wks × 38 h), no OT loading.
function costEntry(db, ctx, user, e) {
  const dow = new Date(e.work_date + 'T00:00:00Z').getUTCDay();
  const state = stateOf(ctx, user.home_branch_id || ctx.branch?.id) || ctx.branch?.code;
  const rate = rateFor(db, ctx.company.id, state, user.trade || 'Fire', user.classification || '');
  const ordHours = rate ? rate.ordinary_hours : 7.6;
  let ordinary = 0, ot1 = 0, ot2 = 0;
  const h = e.hours;
  if (user.employment_type === 'salary') { ordinary = h; }
  else if (dow === 0) { ot2 = h; }
  else if (dow === 6) { ot1 = Math.min(h, 2); ot2 = Math.max(0, h - 2); } // first 2h Saturday at 1.5, then 2.0 (configurable in rate table later)
  else { ordinary = Math.min(h, ordHours); ot1 = Math.min(Math.max(0, h - ordHours), 2); ot2 = Math.max(0, h - ordHours - 2); }
  let base;
  if (user.hourly_rate_override) base = user.hourly_rate_override;
  else if (user.employment_type === 'salary' && user.annual_salary) base = user.annual_salary / (52 * 38);
  else base = rate ? rate.base_hourly : 0;
  const oncost = rate ? rate.oncost_pct : 0.32;
  const allowances = rate && user.employment_type !== 'salary' && h > 0 ? rate.daily_allowances : 0;
  const m1 = rate ? rate.ot_1 : 1.5, m2 = rate ? rate.ot_2 : 2.0;
  const wages = ordinary * base + ot1 * base * m1 + ot2 * base * m2 + allowances;
  const cost = wages * (1 + oncost);
  return { ordinary_hours: r2(ordinary), ot1_hours: r2(ot1), ot2_hours: r2(ot2), rate_used: r2(base), cost: r2(cost), rate_found: !!rate };
}
const r2 = (x) => Math.round(x * 100) / 100;

function hoursBetween(start, end, breakMin) {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(':').map(Number); const [eh, em] = end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm); if (mins < 0) mins += 24 * 60;
  return Math.max(0, r2((mins - (breakMin || 0)) / 60));
}

function weekStart(d) { const x = new Date(d + 'T00:00:00Z'); const day = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - day); return x.toISOString().slice(0, 10); }
const TZ = require('../tz');
function today(ctx) { return TZ.todayIn(TZ.tzFor(ctx && ctx.branch)); }
function nowHM(ctx) { return TZ.nowHMIn(TZ.tzFor(ctx && ctx.branch)); }

// Recompute labour actuals on a project's labour cost code from approved timesheets (plus open ones as "uncosted" is not included).
function syncLabour(db, projectId) {
  const p = db.prepare('SELECT id, discipline FROM projects WHERE id = ?').get(projectId); if (!p) return;
  const total = db.prepare("SELECT COALESCE(SUM(cost),0) c FROM timesheet_entries WHERE project_id = ? AND status = 'approved'").get(projectId).c;
  // Put timesheet labour into the first '*labour*' cost code; if none, create one.
  const cc = db.prepare("SELECT id FROM cost_codes WHERE project_id = ? AND name LIKE '%labour%' ORDER BY code LIMIT 1").get(projectId);
  if (cc) db.prepare('UPDATE cost_codes SET actual = ROUND(?, 2) WHERE id = ?').run(total, cc.id); // NOTE: replaces seeded placeholder actuals once real timesheets exist
  else db.prepare("INSERT INTO cost_codes (project_id, code, name, budget, committed, actual, forecast) VALUES (?, '20', 'Labour (timesheets)', 0, 0, ?, 0)").run(projectId, total);
}

module.exports = (r) => {
  r.get('/api/meta/people', () => ({ trades: TRADES, employment: EMPLOYMENT }));

  // ---- staff (company-wide list for BM/finance/directors; employment fields) ----
  r.get('/api/staff', A.requireUser, (ctx) => {
    if (!ctx.company) throw new HttpError(403, 'Choose a company first');
    if (!(ctx.user.is_group_admin || ['branch_manager', 'finance'].includes(ctx.role))) throw new HttpError(403, 'Branch Manager or Finance');
    const where = ctx.user.is_group_admin && !ctx.query.branch_id ? 'u.company_id = ?' : 'u.company_id = ? AND (u.home_branch_id = ? OR u.id IN (SELECT user_id FROM branch_members WHERE branch_id = ?))';
    const params = ctx.user.is_group_admin && !ctx.query.branch_id ? [ctx.company.id] : [ctx.company.id, Number(ctx.query.branch_id || ctx.branch.id), Number(ctx.query.branch_id || ctx.branch.id)];
    return ctx.db.prepare(`SELECT u.id, u.name, u.email, u.initials, u.active, u.employment_type, u.trade, u.classification, u.home_branch_id, u.annual_salary, u.hourly_rate_override, u.mobile, u.start_date,
        b.code home_branch, (SELECT GROUP_CONCAT(role) FROM branch_members m WHERE m.user_id = u.id) roles,
        (SELECT COALESCE(SUM(hours),0) FROM timesheet_entries t WHERE t.user_id = u.id AND t.work_date >= date('now','-28 days')) hours_4w
      FROM users u LEFT JOIN branches b ON b.id = u.home_branch_id WHERE ${where} AND u.is_platform_admin = 0 ORDER BY b.code, u.name`).all(...params);
  });
  r.patch('/api/staff/:id', A.requireUser, (ctx) => {
    if (!(ctx.user.is_group_admin || ctx.role === 'branch_manager')) throw new HttpError(403, 'Branch Manager only');
    const u = ctx.db.prepare('SELECT id FROM users WHERE id = ? AND company_id = ?').get(Number(ctx.params.id), ctx.company.id); if (!u) throw new HttpError(404, 'Not found');
    const allowed = ['employment_type', 'trade', 'classification', 'home_branch_id', 'annual_salary', 'hourly_rate_override', 'mobile', 'start_date'];
    const sets = []; const vals = [];
    for (const k of allowed) if (k in ctx.body) { sets.push(`${k} = ?`); vals.push(ctx.body[k] === '' ? null : ctx.body[k]); }
    if (!sets.length) throw new HttpError(400, 'Nothing to update');
    ctx.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, u.id);
    A.audit(ctx, 'staff.update', 'user', u.id, Object.fromEntries(Object.entries(ctx.body).filter(([k]) => k !== 'annual_salary')));
    return { ok: true };
  });

  // ---- wage rates ----
  r.get('/api/rates', A.requireUser, (ctx) => {
    if (!ctx.company) throw new HttpError(403, 'Choose a company first');
    return ctx.db.prepare('SELECT * FROM wage_rates WHERE company_id = ? ORDER BY state, trade, base_hourly').all(ctx.company.id);
  });
  r.put('/api/rates', A.requireUser, (ctx) => {
    if (!(ctx.user.is_group_admin || ctx.role === 'branch_manager')) throw new HttpError(403, 'Directors or Branch Managers');
    const up = ctx.db.prepare(`INSERT INTO wage_rates (company_id, state, trade, classification, base_hourly, ot_1, ot_2, sat_mult, sun_mult, daily_allowances, oncost_pct, ordinary_hours, source, effective_from)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(company_id, state, trade, classification) DO UPDATE SET base_hourly=excluded.base_hourly, ot_1=excluded.ot_1, ot_2=excluded.ot_2, sat_mult=excluded.sat_mult,
      sun_mult=excluded.sun_mult, daily_allowances=excluded.daily_allowances, oncost_pct=excluded.oncost_pct, ordinary_hours=excluded.ordinary_hours, source=excluded.source, effective_from=excluded.effective_from`);
    for (const x of ctx.body.rates || []) { if (!x.state || !x.trade || !x.classification) continue; up.run(ctx.company.id, x.state.toUpperCase(), x.trade, x.classification, +x.base_hourly || 0, +x.ot_1 || 1.5, +x.ot_2 || 2, +x.sat_mult || 1.5, +x.sun_mult || 2, +x.daily_allowances || 0, +x.oncost_pct || 0.32, +x.ordinary_hours || 7.6, x.source || null, x.effective_from || null); }
    if (ctx.body.delete_ids?.length) ctx.db.prepare(`DELETE FROM wage_rates WHERE company_id = ? AND id IN (${ctx.body.delete_ids.map(() => '?').join(',')})`).run(ctx.company.id, ...ctx.body.delete_ids);
    A.audit(ctx, 'rates.update', 'company', ctx.company.id, { n: (ctx.body.rates || []).length });
    return ctx.db.prepare('SELECT * FROM wage_rates WHERE company_id = ? ORDER BY state, trade, base_hourly').all(ctx.company.id);
  });

  // ---- my timesheet: today + this week, clock in/out ----
  function myJobs(ctx) { const s = A.projectScope(ctx); return ctx.db.prepare(`SELECT p.id, p.number, p.name FROM projects p WHERE ${s.sql} AND p.status = 'live' ORDER BY p.number`).all(...s.params); }
  function week(ctx, userId, ws) {
    return ctx.db.prepare(`SELECT t.*, p.number project_number, p.name project_name FROM timesheet_entries t JOIN projects p ON p.id = t.project_id
      WHERE t.user_id = ? AND t.work_date >= ? AND t.work_date < date(?, '+7 days') ORDER BY t.work_date, t.start_time`).all(userId, ws, ws);
  }
  r.get('/api/timesheets/me', A.requireBranch, (ctx) => {
    const ws = ctx.query.week || weekStart(today(ctx));
    const open = ctx.db.prepare("SELECT t.*, p.number project_number FROM timesheet_entries t JOIN projects p ON p.id = t.project_id WHERE t.user_id = ? AND t.end_time IS NULL AND t.status = 'open' ORDER BY t.id DESC LIMIT 1").get(ctx.user.id);
    const me = ctx.db.prepare('SELECT employment_type, trade, classification FROM users WHERE id = ?').get(ctx.user.id);
    return { week_start: ws, jobs: myJobs(ctx), entries: week(ctx, ctx.user.id, ws), clocked_in: open || null, me, today: today(ctx), now: nowHM(ctx) };
  });
  r.post('/api/timesheets/clock-in', A.requireBranch, (ctx) => {
    const pid = Number(ctx.body.project_id);
    A.loadProject(ctx, pid); // must be a job they can see
    if (ctx.db.prepare("SELECT 1 FROM timesheet_entries WHERE user_id = ? AND end_time IS NULL AND status = 'open'").get(ctx.user.id)) throw new HttpError(409, 'Already signed in — sign out first');
    const info = ctx.db.prepare('INSERT INTO timesheet_entries (user_id, project_id, cost_code, work_date, start_time, notes) VALUES (?,?,?,?,?,?)').run(ctx.user.id, pid, ctx.body.cost_code || null, ctx.body.date || today(ctx), ctx.body.time || nowHM(ctx), ctx.body.notes || null);
    A.audit(ctx, 'timesheet.clock_in', 'timesheet', Number(info.lastInsertRowid), { project_id: pid });
    return { ok: true, id: Number(info.lastInsertRowid) };
  });
  r.post('/api/timesheets/clock-out', A.requireBranch, (ctx) => {
    const e = ctx.db.prepare("SELECT * FROM timesheet_entries WHERE user_id = ? AND end_time IS NULL AND status = 'open' ORDER BY id DESC LIMIT 1").get(ctx.user.id);
    if (!e) throw new HttpError(409, 'Not signed in');
    const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
    const end = ctx.body.time || nowHM(ctx); const brk = ctx.body.break_min ?? 30;
    const hours = hoursBetween(e.start_time, end, brk);
    const c = costEntry(ctx.db, ctx, user, { ...e, hours });
    ctx.db.prepare('UPDATE timesheet_entries SET end_time = ?, break_min = ?, hours = ?, ordinary_hours = ?, ot1_hours = ?, ot2_hours = ?, rate_used = ?, cost = ?, notes = COALESCE(?, notes) WHERE id = ?')
      .run(end, brk, hours, c.ordinary_hours, c.ot1_hours, c.ot2_hours, c.rate_used, c.cost, ctx.body.notes || null, e.id);
    A.audit(ctx, 'timesheet.clock_out', 'timesheet', e.id, { hours });
    return { ok: true, hours, rate_found: c.rate_found };
  });
  // Manual entry / edit (own, while open or rejected). Body: project_id, work_date, start_time, end_time, break_min, notes
  r.post('/api/timesheets/entries', A.requireBranch, (ctx) => {
    const b = ctx.body; const pid = Number(b.project_id); A.loadProject(ctx, pid);
    const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
    const hours = b.hours != null ? +b.hours : hoursBetween(b.start_time, b.end_time, b.break_min ?? 30);
    const c = costEntry(ctx.db, ctx, user, { work_date: b.work_date, hours });
    const info = ctx.db.prepare('INSERT INTO timesheet_entries (user_id, project_id, cost_code, work_date, start_time, end_time, break_min, hours, ordinary_hours, ot1_hours, ot2_hours, rate_used, cost, notes, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(ctx.user.id, pid, b.cost_code || null, b.work_date, b.start_time || null, b.end_time || null, b.break_min ?? 30, hours, c.ordinary_hours, c.ot1_hours, c.ot2_hours, c.rate_used, c.cost, b.notes || null, 'open');
    return { ok: true, id: Number(info.lastInsertRowid), hours, cost: c.cost };
  });
  r.delete('/api/timesheets/entries/:id', A.requireBranch, (ctx) => {
    const e = ctx.db.prepare('SELECT * FROM timesheet_entries WHERE id = ?').get(Number(ctx.params.id)); if (!e) throw new HttpError(404, 'Not found');
    const mine = e.user_id === ctx.user.id; const mgr = ['branch_manager', 'pm', 'supervisor', 'group_admin'].includes(ctx.role);
    if (!(mine || mgr) || e.status === 'approved') throw new HttpError(403, 'Cannot delete');
    ctx.db.prepare('DELETE FROM timesheet_entries WHERE id = ?').run(e.id); return { ok: true };
  });
  r.post('/api/timesheets/submit', A.requireBranch, (ctx) => {
    const ws = ctx.body.week || weekStart(today(ctx));
    const n = ctx.db.prepare("UPDATE timesheet_entries SET status = 'submitted' WHERE user_id = ? AND status = 'open' AND end_time IS NOT NULL AND work_date >= ? AND work_date < date(?, '+7 days')").run(ctx.user.id, ws, ws).changes;
    A.audit(ctx, 'timesheet.submit', 'user', ctx.user.id, { week: ws, entries: n });
    return { ok: true, submitted: n };
  });

  // ---- approvals (PM / supervisor on their jobs; BM on all) ----
  r.get('/api/timesheets/approvals', A.requireRole('branch_manager', 'pm', 'supervisor', 'finance'), (ctx) => {
    const s = A.projectScope(ctx);
    const ws = ctx.query.week || weekStart(today(ctx));
    const rows = ctx.db.prepare(`SELECT t.*, u.name user_name, u.initials, u.employment_type, u.trade, p.number project_number, p.name project_name FROM timesheet_entries t
      JOIN users u ON u.id = t.user_id JOIN projects p ON p.id = t.project_id WHERE ${s.sql} AND t.work_date >= ? AND t.work_date < date(?, '+7 days') AND t.end_time IS NOT NULL
      ORDER BY u.name, t.work_date, t.start_time`).all(...s.params, ws, ws);
    const byUser = {}; rows.forEach(t => { const g = byUser[t.user_id] = byUser[t.user_id] || { user_id: t.user_id, user_name: t.user_name, initials: t.initials, trade: t.trade, employment_type: t.employment_type, entries: [], hours: 0, ot: 0, cost: 0, submitted: 0, approved: 0, open: 0 }; g.entries.push(t); g.hours += t.hours; g.ot += t.ot1_hours + t.ot2_hours; g.cost += t.cost; g[t.status === 'submitted' ? 'submitted' : t.status === 'approved' ? 'approved' : 'open']++; });
    return { week_start: ws, people: Object.values(byUser) };
  });
  r.post('/api/timesheets/approve', A.requireRole('branch_manager', 'pm', 'supervisor'), (ctx) => {
    const ids = (ctx.body.ids || []).map(Number); if (!ids.length) throw new HttpError(400, 'ids required');
    const s = A.projectScope(ctx);
    const ok = ctx.db.prepare(`SELECT t.id, t.project_id FROM timesheet_entries t JOIN projects p ON p.id = t.project_id WHERE ${s.sql} AND t.id IN (${ids.map(() => '?').join(',')}) AND t.status IN ('submitted','open') AND t.end_time IS NOT NULL`).all(...s.params, ...ids);
    const act = ctx.body.action === 'reject' ? 'rejected' : 'approved';
    const upd = ctx.db.prepare("UPDATE timesheet_entries SET status = ?, approved_by = ?, approved_at = datetime('now') WHERE id = ?");
    ok.forEach(t => upd.run(act, ctx.user.id, t.id));
    new Set(ok.map(t => t.project_id)).forEach(pid => syncLabour(ctx.db, pid));
    A.audit(ctx, `timesheet.${act}`, 'timesheet', null, { ids: ok.map(t => t.id) });
    return { ok: true, [act]: ok.length };
  });

  // ---- attendance: per job, who was expected (crew granted to the job, wages/field staff) vs who signed in on a given day ----
  r.get('/api/attendance', A.requireRole('supervisor', 'pm', 'branch_manager', 'finance'), (ctx) => {
    const tz = TZ.tzFor(ctx.branch); const date = ctx.query.date || today(ctx); const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    const s = A.projectScope(ctx);
    const projects = ctx.db.prepare(`SELECT p.id, p.number, p.name, p.discipline, u.name lead_pm_name FROM projects p LEFT JOIN users u ON u.id = p.lead_pm_id WHERE ${s.sql} AND p.status = 'live' ORDER BY p.number`).all(...s.params);
    const crewQ = ctx.db.prepare(`SELECT u.id, u.name, u.initials, u.trade, u.mobile FROM project_access pa JOIN users u ON u.id = pa.user_id JOIN branch_members bm ON bm.user_id = u.id AND bm.branch_id = ? AND bm.role = 'field' WHERE pa.project_id = ? AND u.active = 1 AND u.employment_type = 'wages' ORDER BY u.name`);
    const inQ = ctx.db.prepare(`SELECT t.user_id, MIN(t.start_time) start_time, MAX(COALESCE(t.end_time, '')) end_time, SUM(t.hours) hours FROM timesheet_entries t WHERE t.project_id = ? AND t.work_date = ? GROUP BY t.user_id`);
    // someone signed in elsewhere today counts as "on another job", not absent
    const elsewhereQ = ctx.db.prepare(`SELECT p.number FROM timesheet_entries t JOIN projects p ON p.id = t.project_id WHERE t.user_id = ? AND t.work_date = ? AND t.project_id != ? LIMIT 1`);
    const out = projects.map(p => {
      const crew = crewQ.all(ctx.branch.id, p.id); const ins = new Map(inQ.all(p.id, date).map(x => [x.user_id, x]));
      const people = crew.map(u => { const i = ins.get(u.id); if (i) return { ...u, status: i.end_time ? 'signed_out' : 'present', start_time: i.start_time, end_time: i.end_time || null, hours: i.hours }; const e = elsewhereQ.get(u.id, date, p.id); return { ...u, status: e ? 'elsewhere' : 'away', elsewhere: e?.number || null }; });
      // people who signed in but aren't on the crew list (e.g. borrowed from another job)
      ctx.db.prepare(`SELECT u.id, u.name, u.initials, u.trade, MIN(t.start_time) start_time, MAX(COALESCE(t.end_time,'')) end_time, SUM(t.hours) hours FROM timesheet_entries t JOIN users u ON u.id = t.user_id WHERE t.project_id = ? AND t.work_date = ? AND u.id NOT IN (${crew.map(() => '?').join(',') || '0'}) GROUP BY u.id`).all(p.id, date, ...crew.map(c => c.id))
        .forEach(x => people.push({ ...x, status: x.end_time ? 'signed_out' : 'present', end_time: x.end_time || null, visitor: true }));
      const present = people.filter(x => ['present', 'signed_out'].includes(x.status)).length; const away = people.filter(x => x.status === 'away').length; const elsewhere = people.filter(x => x.status === 'elsewhere').length;
      return { ...p, expected: crew.length, present, away, elsewhere, people };
    });
    const t = out.reduce((a, p) => ({ expected: a.expected + p.expected, present: a.present + p.present, away: a.away + p.away, elsewhere: a.elsewhere + p.elsewhere }), { expected: 0, present: 0, away: 0, elsewhere: 0 });
    const isToday = date === today(ctx);
    return { date, is_weekend: dow === 0 || dow === 6, is_today: isToday, local_hour: isToday ? TZ.hourIn(tz) : null, timezone: tz, projects: out, totals: t };
  });

  // Labour summary for a job (hours and cost by person, by week) — shown on the project page
  r.get('/api/projects/:id/labour', A.requireBranch, (ctx) => {
    const p = A.loadProject(ctx, ctx.params.id);
    const byUser = ctx.db.prepare(`SELECT u.id, u.name, u.trade, u.employment_type, SUM(t.hours) hours, SUM(t.ot1_hours + t.ot2_hours) ot, SUM(t.cost) cost, SUM(CASE WHEN t.status='approved' THEN t.cost ELSE 0 END) approved_cost
      FROM timesheet_entries t JOIN users u ON u.id = t.user_id WHERE t.project_id = ? GROUP BY u.id ORDER BY hours DESC`).all(p.id);
    const byWeek = ctx.db.prepare(`SELECT date(work_date, '-' || ((strftime('%w', work_date) + 6) % 7) || ' days') week, SUM(hours) hours, SUM(cost) cost FROM timesheet_entries WHERE project_id = ? GROUP BY week ORDER BY week`).all(p.id);
    const tot = ctx.db.prepare("SELECT COALESCE(SUM(hours),0) hours, COALESCE(SUM(cost),0) cost, COALESCE(SUM(CASE WHEN status='approved' THEN cost ELSE 0 END),0) approved_cost, COALESCE(SUM(CASE WHEN status IN ('open','submitted') THEN cost ELSE 0 END),0) pending_cost FROM timesheet_entries WHERE project_id = ?").get(p.id);
    return { by_user: byUser, by_week: byWeek, totals: tot };
  });
};
module.exports.costEntry = costEntry; module.exports.hoursBetween = hoursBetween; module.exports.weekStart = weekStart; module.exports.syncLabour = syncLabour;
