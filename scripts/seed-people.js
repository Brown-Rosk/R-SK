'use strict';
// Seeds employment data, wage-rate tables (PLACEHOLDER figures — load real EBA/award rates), timesheets, toolbox talks, onboarding.
const crypto = require('node:crypto');
let n = 7; const rnd = () => { n = (n * 1103515245 + 12345) & 0x7fffffff; return n / 0x7fffffff; };
const between = (a, b) => a + rnd() * (b - a);
const r2 = (x) => Math.round(x * 100) / 100;

const CLASSES = { Fire: ['Sprinkler fitter — Level 1', 'Sprinkler fitter — Level 3', 'Fire detection technician', 'Apprentice (3rd yr)'], Mechanical: ['Mechanical plumber', 'Sheetmetal worker', 'Apprentice (3rd yr)'], Electrical: ['Electrician — Grade 1', 'Electrician — Grade 3', 'Apprentice (3rd yr)'], Hydraulic: ['Plumber — Level 2', 'Apprentice (3rd yr)'] };
// Placeholder base rates by state (AUD/hr). NOT EBA figures — illustrative only, labelled as such in the UI.
const STATE_BASE = { VIC: 52, NSW: 54, QLD: 50, WA: 55, SA: 48, TAS: 46, NZ: 44, SYD: 54 };
const CLASS_MULT = { 'Sprinkler fitter — Level 1': 0.92, 'Sprinkler fitter — Level 3': 1.05, 'Fire detection technician': 1.0, 'Apprentice (3rd yr)': 0.62, 'Mechanical plumber': 1.0, 'Sheetmetal worker': 0.95, 'Electrician — Grade 1': 0.95, 'Electrician — Grade 3': 1.08, 'Plumber — Level 2': 1.0 };

function seedPeople(db) {
  const companies = db.prepare('SELECT id, name FROM companies').all();
  for (const c of companies) {
    // ---- rate tables ----
    const branches = db.prepare('SELECT id, code FROM branches WHERE company_id = ?').all(c.id);
    const ins = db.prepare('INSERT OR IGNORE INTO wage_rates (company_id, state, trade, classification, base_hourly, ot_1, ot_2, sat_mult, sun_mult, daily_allowances, oncost_pct, ordinary_hours, source, effective_from) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const b of branches) for (const [trade, classes] of Object.entries(CLASSES)) for (const cl of classes)
      ins.run(c.id, b.code, trade, cl, r2((STATE_BASE[b.code] || 50) * (CLASS_MULT[cl] || 1)), 1.5, 2.0, 1.5, 2.0, 38.5, 0.32, 7.6, 'PLACEHOLDER — replace with applicable EBA / award', '2026-07-01');

    // ---- employment on existing users (by branch role) ----
    const members = db.prepare(`SELECT u.id, u.name, m.branch_id, m.role, b.code FROM users u JOIN branch_members m ON m.user_id = u.id JOIN branches b ON b.id = m.branch_id WHERE u.company_id = ? GROUP BY u.id`).all(c.id);
    const upd = db.prepare('UPDATE users SET employment_type = ?, trade = ?, classification = ?, home_branch_id = ?, annual_salary = ?, start_date = ? WHERE id = ? AND employment_type IS NULL');
    for (const m of members) {
      const trade = /Mechanical/.test(m.name) ? 'Mechanical' : 'Fire';
      if (['branch_manager', 'pm', 'finance', 'estimator'].includes(m.role)) upd.run('salary', m.role === 'finance' ? 'Office' : trade, m.role === 'pm' ? 'Project Manager' : m.role === 'branch_manager' ? 'Branch Manager' : 'Office', m.branch_id, m.role === 'branch_manager' ? 195000 : m.role === 'pm' ? 145000 : 95000, '2024-02-05', m.id);
      else upd.run('wages', trade, trade === 'Fire' ? 'Sprinkler fitter — Level 3' : 'Mechanical plumber', m.branch_id, null, '2023-08-14', m.id);
    }
    // ---- add field staff (wages) to each branch: 3–6 tradespeople, granted as members on 1–2 jobs ----
    const addUser = db.prepare('INSERT OR IGNORE INTO users (company_id, email, name, initials, password_hash, employment_type, trade, classification, home_branch_id, start_date) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const getUser = db.prepare('SELECT id FROM users WHERE email = ?');
    const mem = db.prepare('INSERT OR IGNORE INTO branch_members (user_id, branch_id, role) VALUES (?,?,?)');
    const grant = db.prepare('INSERT OR IGNORE INTO project_access (project_id, user_id, level, granted_by) VALUES (?,?,?,?)');
    const A = require('../src/auth');
    const FIRST = ['Jordan', 'Riley', 'Taylor', 'Morgan', 'Casey', 'Jamie', 'Alex', 'Drew', 'Blake', 'Reece', 'Kai', 'Toby', 'Sienna', 'Lachie', 'Noah', 'Ethan'];
    const LAST = ['Nguyen', 'Smith', 'Kelly', 'Papadopoulos', 'Singh', 'Walsh', 'Costa', 'Murray', 'Ahmed', 'Brennan', 'Lee', 'Hart', 'Doyle', 'Rossi', 'Khan', 'Burns'];
    const domain = c.id === 1 ? 'premiersg.com.au' : 'harbourlinehydraulics.com.au';
    let fi = 0;
    for (const b of branches) {
      const jobs = db.prepare("SELECT id, discipline, lead_pm_id FROM projects WHERE branch_id = ? AND status = 'live'").all(b.id); if (!jobs.length) continue;
      const bm = db.prepare("SELECT user_id FROM branch_members WHERE branch_id = ? AND role = 'branch_manager' LIMIT 1").get(b.id)?.user_id;
      const count = Math.min(14, Math.max(4, Math.round(jobs.length * 1.6)));
      for (let i = 0; i < count; i++) {
        const name = `${FIRST[fi % FIRST.length]} ${LAST[(fi + Math.floor(fi / FIRST.length) * 3) % LAST.length]}`; fi++; // unique for the first 256 people
        const job = jobs[i % jobs.length]; const trade = { fire: 'Fire', mechanical: 'Mechanical', electrical: 'Electrical', hydraulic: 'Hydraulic' }[job.discipline] || 'Fire';
        const cls = CLASSES[trade][i % CLASSES[trade].length];
        const email = name.toLowerCase().replace(' ', '.') + '@' + domain;
        addUser.run(c.id, email, name, name.split(' ').map(w => w[0]).join(''), A.hashPassword('psg2026'), 'wages', trade, cls, b.id, '2025-03-10');
        const uid = getUser.get(email).id; mem.run(uid, b.id, 'field');
        grant.run(job.id, uid, 'member', bm);
      }
    }
    // ---- timesheets: 8 weeks for every wages employee on their granted jobs ----
    const wages = db.prepare(`SELECT u.id, u.trade, u.classification, u.home_branch_id, b.code state FROM users u JOIN branches b ON b.id = u.home_branch_id WHERE u.company_id = ? AND u.employment_type = 'wages'`).all(c.id);
    const insTs = db.prepare('INSERT INTO timesheet_entries (user_id, project_id, work_date, start_time, end_time, break_min, hours, ordinary_hours, ot1_hours, ot2_hours, rate_used, cost, status, approved_by, approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const rateOf = db.prepare('SELECT * FROM wage_rates WHERE company_id = ? AND state = ? AND trade = ? AND classification = ?');
    const start = new Date('2026-09-07T00:00:00Z'); // Monday, 8 weeks before the demo week
    for (const w of wages) {
      const jobs = db.prepare('SELECT project_id FROM project_access WHERE user_id = ?').all(w.id).map(x => x.project_id); if (!jobs.length) continue;
      const rate = rateOf.get(c.id, w.state, w.trade, w.classification) || { base_hourly: 50, ot_1: 1.5, ot_2: 2, daily_allowances: 38.5, oncost_pct: 0.32, ordinary_hours: 7.6 };
      const bm = db.prepare("SELECT user_id FROM branch_members WHERE branch_id = ? AND role = 'branch_manager' LIMIT 1").get(w.home_branch_id)?.user_id;
      for (let d = 0; d < 59; d++) {
        const day = new Date(start); day.setUTCDate(day.getUTCDate() + d); const dow = day.getUTCDay(); const iso = day.toISOString().slice(0, 10);
        if (iso > '2026-11-04') break;
        if (dow === 0) continue; if (dow === 6 && rnd() > 0.25) continue; if (rnd() < (iso === '2026-11-04' ? 0.12 : 0.05)) continue; // odd day off; ~12% away on the demo day
        const job = jobs[Math.floor(rnd() * jobs.length)];
        const hours = dow === 6 ? r2(between(4, 6)) : r2(between(7.6, rnd() < 0.3 ? 10 : 8.1));
        let ord = 0, ot1 = 0, ot2 = 0;
        if (dow === 6) { ot1 = Math.min(hours, 2); ot2 = hours - ot1; } else { ord = Math.min(hours, rate.ordinary_hours); ot1 = Math.min(Math.max(0, hours - ord), 2); ot2 = Math.max(0, hours - ord - ot1); }
        const wagesAmt = ord * rate.base_hourly + ot1 * rate.base_hourly * rate.ot_1 + ot2 * rate.base_hourly * rate.ot_2 + rate.daily_allowances;
        const cost = r2(wagesAmt * (1 + rate.oncost_pct));
        const startT = '06:' + (rnd() < 0.5 ? '30' : '45'); const endMin = 6 * 60 + 30 + Math.round((hours + 0.5) * 60); const endT = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
        const thisWeek = iso >= '2026-11-02'; const lastWeek = iso >= '2026-10-26' && iso < '2026-11-02';
        const status = thisWeek ? 'open' : lastWeek ? (rnd() < 0.7 ? 'submitted' : 'approved') : 'approved';
        insTs.run(w.id, job, iso, startT, endT, 30, hours, r2(ord), r2(ot1), r2(ot2), rate.base_hourly, cost, status, status === 'approved' ? bm : null, status === 'approved' ? iso + ' 17:30:00' : null);
      }
    }
    // Seeded cost-code actuals already include labour; don't overwrite them with the (smaller) 8-week timesheet total.

    // ---- toolbox talks: 1–3 per live job over the last 6 weeks ----
    const TOPICS = ['Working at heights — EWP pre-start', 'Hot works permit & fire watch', 'Manual handling — pipe and fittings', 'Silica dust — drilling masonry', 'Electrical isolation & LOTO', 'Heat stress — summer works', 'Site traffic & exclusion zones', 'Confined spaces — tank entry', 'Ladder safety', 'Housekeeping & waste', 'Working near live services', 'Emergency evacuation drill'];
    const insTalk = db.prepare('INSERT INTO toolbox_talks (project_id, held_on, topic, presenter_id, notes, hazards, actions, attendees, attendee_count, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const b of branches) {
      const jobs = db.prepare("SELECT id FROM projects WHERE branch_id = ? AND status = 'live'").all(b.id);
      for (const j of jobs) {
        const crew = db.prepare('SELECT u.id, u.name FROM project_access pa JOIN users u ON u.id = pa.user_id WHERE pa.project_id = ? AND u.employment_type = \'wages\'').all(j.id);
        const sup = db.prepare("SELECT u.id FROM project_access pa JOIN users u ON u.id = pa.user_id JOIN branch_members m ON m.user_id = u.id AND m.branch_id = ? WHERE pa.project_id = ? AND m.role = 'supervisor' LIMIT 1").get(b.id, j.id)?.id || crew[0]?.id;
        if (!sup) continue;
        const nTalks = 1 + Math.floor(rnd() * 3);
        for (let k = 0; k < nTalks; k++) {
          const day = new Date('2026-11-03T00:00:00Z'); day.setUTCDate(day.getUTCDate() - Math.floor(rnd() * 42)); if (day.getUTCDay() === 0) day.setUTCDate(day.getUTCDate() - 1);
          const topic = TOPICS[Math.floor(rnd() * TOPICS.length)];
          const att = crew.filter(() => rnd() < 0.85).map(u => ({ id: u.id, name: u.name, signed: true }));
          insTalk.run(j.id, day.toISOString().slice(0, 10), topic, sup, 'Delivered at pre-start. All attendees signed the sheet.', topic.includes('heights') ? 'Falls from height; dropped objects' : topic.includes('Hot') ? 'Ignition of combustibles; burns' : null, rnd() < 0.4 ? 'Replace damaged harness — ordered' : null, JSON.stringify(att), att.length, day.toISOString().slice(0, 10) + ' 06:45:00');
        }
      }
    }
    // ---- onboarding ----
    db.prepare("INSERT OR IGNORE INTO onboarding (company_id, token, welcome, video_links, uniform_link, timesheet_instructions, contacts, documents, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'))")
      .run(c.id, crypto.randomBytes(8).toString('hex'),
        c.id === 1 ? 'Welcome to Premier Services Group. We are a fire, HVAC and electrical contractor with 450+ people across Australia and New Zealand. This page has everything you need before your first day.' : `Welcome to ${c.name}.`,
        JSON.stringify(c.id === 1 ? [{ title: 'About Premier (2 min)', url: '[paste video link]' }, { title: 'Site safety induction', url: '[paste video link]' }] : []),
        c.id === 1 ? '[uniform supplier order link]' : '', 'Sign in and out on every job, every day — your hours are costed to the job you are on. If you forget, tell your supervisor the same day.',
        JSON.stringify(c.id === 1 ? [{ name: 'Jayden Brown', role: 'Victorian Branch Manager', phone: '0460 312 209', email: 'jayden.brown@premiersg.com.au' }] : []), '[]');
  }
}
module.exports = { seedPeople };
