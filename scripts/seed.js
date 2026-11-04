'use strict';
// Seed: branches, VIC users, four VIC projects with cost codes, SOV, variations and claims history.
// All project data is SAMPLE DATA for testing the workflow — not real PSG figures.
const path = require('node:path');
const A = require('../src/auth');

const PW = 'psg2026'; // every seeded user; change on first login in a real pilot

function seed(db) {
  db.exec('BEGIN');
  try {
    const ins = (sql) => db.prepare(sql);
    const branch = ins('INSERT INTO branches (code, name, country, currency, gst_rate, offices, job_prefix, status) VALUES (?,?,?,?,?,?,?,?)');
    const B = {};
    [['VIC', 'Victoria', 'AU', 'AUD', 0.10, 'Keysborough · Melbourne CBD · Geelong', 'VIC', 'live'],
     ['NSW', 'New South Wales', 'AU', 'AUD', 0.10, 'Sydney', 'NSW', 'onboarding'],
     ['QLD', 'Queensland', 'AU', 'AUD', 0.10, 'Brisbane', 'QLD', 'onboarding'],
     ['WA', 'Western Australia', 'AU', 'AUD', 0.10, 'Perth', 'WA', 'launch_2027'],
     ['SA', 'South Australia', 'AU', 'AUD', 0.10, 'Adelaide', 'SA', 'onboarding'],
     ['TAS', 'Tasmania', 'AU', 'AUD', 0.10, 'Hobart', 'TAS', 'onboarding'],
     ['NZ', 'New Zealand', 'NZ', 'NZD', 0.15, 'Auckland · Wellington · Dunedin', 'NZ', 'onboarding']]
      .forEach(b => { B[b[0]] = Number(branch.run(...b).lastInsertRowid); });

    const user = ins('INSERT INTO users (email, name, initials, password_hash, is_group_admin) VALUES (?,?,?,?,?)');
    const U = {};
    const mk = (key, email, name, admin = 0) => { U[key] = Number(user.run(email, name, name.replace(/[^A-Za-z ]/g, '').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase(), A.hashPassword(PW), admin).lastInsertRowid); };
    mk('jb', 'jayden.brown@premiersg.com.au', 'Jayden Brown');
    mk('wk', 'wade.kneale@premiersg.com.au', 'Wade Kneale');
    mk('nb', 'nik.borobokas@premiersg.com.au', 'Nik Borobokas');
    mk('mm', 'matt.manjiviona@premiersg.com.au', 'Matt Manjiviona');
    mk('lg', 'lachlan.gillard@premiersg.com.au', 'Lachlan Gillard');
    mk('nk', 'nathan.kurzemnieks@premiersg.com.au', 'Nathan Kurzemnieks');
    mk('fin', 'finance@premiersg.com.au', 'Finance (VIC)');
    mk('dir', 'director@premiersg.com.au', 'Group Director', 1);

    const mem = ins('INSERT INTO branch_members (user_id, branch_id, role) VALUES (?,?,?)');
    mem.run(U.jb, B.VIC, 'branch_manager'); mem.run(U.jb, B.WA, 'branch_manager');
    mem.run(U.wk, B.VIC, 'pm'); mem.run(U.nb, B.VIC, 'pm'); mem.run(U.mm, B.VIC, 'pm'); mem.run(U.lg, B.VIC, 'pm');
    mem.run(U.nk, B.VIC, 'supervisor'); mem.run(U.fin, B.VIC, 'finance');

    const proj = ins(`INSERT INTO projects (branch_id, number, name, client, head_contractor, lead_pm_id, contract_value, retention_pct, retention_cap_pct, claim_day, start_date, pc_date, tender_margin_pct, status)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const access = ins('INSERT INTO project_access (project_id, user_id, level, granted_by, granted_at) VALUES (?,?,?,?,?)');
    const cc = ins('INSERT INTO cost_codes (project_id, code, name, budget, committed, actual, forecast) VALUES (?,?,?,?,?,?,?)');
    const sov = ins('INSERT INTO sov_items (project_id, code, description, amount, sort) VALUES (?,?,?,?,?)');
    const stage = ins('INSERT INTO programme_stages (project_id, name, pct_complete, sort) VALUES (?,?,?,?)');
    const vo = ins(`INSERT INTO variations (project_id, number, title, source, discipline, status, labour_hours, labour_amt, materials_amt, sub_plant_amt, prelims_margin_amt,
                    submitted_amt, approved_amt, cost_to_date, pct_done, owner_id, client_ref, notes, raised_at, submitted_at, approved_at, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const claim = ins('INSERT INTO claims (project_id, number, period_end, status, serve_by, served_at, certified_at, certified_amt, drafted_by, approved_by) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const line = ins('INSERT INTO claim_lines (claim_id, kind, ref_id, description, contract_amt, prev_claimed, this_claim, sort) VALUES (?,?,?,?,?,?,?,?)');
    const att = ins('INSERT INTO attention_items (project_id, tag, text, link, severity) VALUES (?,?,?,?,?)');

    // ---------- Project 1: Riverside Towers Stage 2 (Wade) ----------
    const p1 = Number(proj.run(B.VIC, '26-0417', 'Riverside Towers Stage 2 — Fire Services', 'Riverside Developments Pty Ltd', 'Meridian Build', U.wk, 4780000, 0.05, 0.05, 5, '2026-02-03', '2027-08-28', 0.15, 'live').lastInsertRowid);
    access.run(p1, U.wk, 'lead', U.jb, '2026-02-03 09:00:00'); access.run(p1, U.nk, 'member', U.jb, '2026-02-10 09:00:00'); access.run(p1, U.lg, 'member', U.jb, '2026-03-01 09:00:00');
    [['10', 'Design & engineering', 142000, 138500, 131200, 140000], ['20', 'Wet fire — labour', 618000, 0, 402900, 655000], ['21', 'Wet fire — materials', 1210000, 1186000, 804300, 1198000],
     ['30', 'Dry fire — labour', 384000, 0, 221700, 391000], ['31', 'Dry fire — materials', 466000, 452800, 318600, 458000], ['40', 'Subcontract — hydraulics', 520000, 520000, 312000, 520000],
     ['50', 'Preliminaries', 296000, 0, 184100, 301000], ['60', 'Commissioning & defects', 95000, 0, 9400, 95000]].forEach(c => cc.run(p1, ...c));
    const S1 = {};
    [['A1', 'Design, documentation & approvals', 180000], ['A2', 'Wet fire — risers, mains & booster', 820000], ['A3', 'Wet fire — floor sprinkler rough-in L1–L14', 1340000],
     ['A4', 'Wet fire — fit-off & heads', 410000], ['A5', 'Dry fire — detection, FIP & cabling', 690000], ['A6', 'Dry fire — EWIS & occupant warning', 310000],
     ['A7', 'Hydraulics subcontract (hydrants & hose reels)', 560000], ['A8', 'Testing, commissioning & certification', 130000], ['A9', 'Preliminaries (time-based)', 340000]]
      .forEach((s, i) => { S1[s[0]] = Number(sov.run(p1, s[0], s[1], s[2], i).lastInsertRowid); });
    [['Design', 100], ['Wet fire — risers & mains', 78], ['Wet fire — floor rough-in', 52], ['Dry fire — detection & EWIS', 41], ['Commissioning', 0]].forEach((s, i) => stage.run(p1, s[0], s[1], i));

    const V1 = {};
    const addVo = (p, store, n, title, src, disc, status, hrs, lab, mat, sub, pm, submitted, approved, cost, pct, owner, ref, notes, raised, subAt, appAt) => {
      store[n] = Number(vo.run(p, n, title, src, disc, status, hrs, lab, mat, sub, pm, submitted, approved, cost, pct, owner, ref, notes, raised, subAt, appAt, appAt).lastInsertRowid);
    };
    addVo(p1, V1, 9, 'Extended hours — weekend works per builder programme', 'Delay / disruption', 'Wet fire', 'rejected', 60, 9000, 0, 0, 4500, 13500, 0, 13500, 100, U.jb, 'SI-019', 'Rejected by Meridian — "within programme float"', '2026-05-12', '2026-05-20', '2026-06-10');
    addVo(p1, V1, 10, 'Change of pipe spec — galv to black steel, L1–L4', 'Design change', 'Wet fire', 'approved', 120, 19200, 28400, 0, 14500, 62100, 58000, 49600, 100, U.lg, 'SI-022', null, '2026-06-02', '2026-06-09', '2026-06-30');
    addVo(p1, V1, 11, 'Additional FIP mimic panel at Carpark B1', 'Client instruction', 'Dry fire', 'approved', 24, 3840, 4200, 0, 1810, 9850, 9850, 7900, 100, U.nk, 'SI-025', null, '2026-07-01', '2026-07-08', '2026-07-22');
    addVo(p1, V1, 12, 'Fire-rated penetrations to L3–L6 riser (builder scope)', 'Client instruction', 'Wet fire', 'approved', 48, 7680, 6900, 0, 4820, 19400, 17800, 15100, 100, U.wk, 'SI-027', null, '2026-07-20', '2026-07-28', '2026-08-18');
    addVo(p1, V1, 13, 'Upgrade booster assembly to CFA requirement', 'Latent condition', 'Wet fire', 'disputed', 52, 8320, 13400, 0, 6580, 28300, null, 24800, 90, U.jb, 'RFI-038', 'Meridian disputes latent condition — says CFA requirement was foreseeable', '2026-08-15', '2026-09-21', null);
    addVo(p1, V1, 14, 'Smoke detection to L12 plant room (not on IFC)', 'Client instruction', 'Dry fire', 'submitted', 36, 5760, 18420, 9200, 12820, 46200, null, 31900, 83, U.wk, 'SI-031', 'Follow-up sent 20 Oct — no response. Clause 36.2 gives 21 days.', '2026-09-12', '2026-09-25', null);
    addVo(p1, V1, 15, 'Stop-work — unlevel slab L5, 2 days standing time', 'Delay / disruption', 'Wet fire', 'submitted', 64, 10240, 0, 1800, 2560, 14600, null, 12900, 100, U.wk, 'NOD-004', null, '2026-10-14', '2026-10-19', null);
    addVo(p1, V1, 16, 'EWIS speakers to revised retail tenancy layout', 'Client instruction', 'Dry fire', 'submitted', 80, 12800, 14300, 0, 7650, 34750, null, 27100, 60, U.nk, 'SI-034', null, '2026-10-20', '2026-10-26', null);
    addVo(p1, V1, 17, 'Relocate L8 sprinkler mains around new duct run', 'Design change', 'Wet fire', 'draft', 40, 6400, 3200, 0, 1600, 0, null, 11200, 70, U.lg, 'RFI-041', 'Work done under protest — price up', '2026-10-28', null, null);
    addVo(p1, V1, 18, 'Additional hydrant to loading dock per RFI-042', 'RFI response', 'Wet fire', 'draft', 30, 4800, 3100, 0, 1000, 0, null, 8900, 100, U.lg, 'RFI-042', null, '2026-10-30', null, null);

    // Six certified claims (Apr–Sep) for project 1 — cumulative progressively
    const cum = { A1: [90000, 180000, 180000, 180000, 180000, 180000], A2: [41000, 123000, 246000, 369000, 492000, 574000], A3: [0, 67000, 201000, 335000, 469000, 589600],
      A4: [0, 0, 0, 20500, 61500, 82000], A5: [0, 34500, 103500, 172500, 207000, 241500], A6: [0, 0, 31000, 62000, 77500, 93000], A7: [56000, 112000, 168000, 224000, 280000, 336000],
      A8: [0, 0, 0, 0, 0, 0], A9: [34000, 68000, 102000, 136000, 170000, 204000] };
    const voCum = { 10: [0, 0, 0, 58000, 58000, 58000], 11: [0, 0, 0, 0, 9850, 9850], 12: [0, 0, 0, 0, 0, 8900] };
    const periods = ['2026-04-30', '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30'];
    periods.forEach((pe, i) => {
      const served = pe.slice(0, 8) === '2026-04-' ? '2026-05-04' : new Date(Date.UTC(2026, Number(pe.slice(5, 7)), 4)).toISOString().slice(0, 10);
      const cid = Number(claim.run(p1, i + 1, pe, 'certified', served, served, new Date(Date.UTC(2026, Number(pe.slice(5, 7)), 24)).toISOString().slice(0, 10), 0, U.wk, U.jb).lastInsertRowid);
      let total = 0; let prevTotal = 0;
      Object.entries(S1).forEach(([code, id], idx) => { const prev = i ? cum[code][i - 1] : 0; const t = cum[code][i] - prev; line.run(cid, 'base', id, `${code} ${db.prepare('SELECT description d FROM sov_items WHERE id=?').get(id).d}`, db.prepare('SELECT amount a FROM sov_items WHERE id=?').get(id).a, prev, t, idx); total += cum[code][i]; prevTotal += prev; });
      Object.entries(voCum).forEach(([n, arr], idx) => { const prev = i ? arr[i - 1] : 0; const t = arr[i] - prev; const v = db.prepare('SELECT * FROM variations WHERE id=?').get(V1[n]); if (arr[i] || prev) line.run(cid, 'variation', V1[n], `VO-0${n} ${v.title}`, v.approved_amt, prev, t, 1000 + idx); total += arr[i]; prevTotal += prev; });
      // certified = cumulative less 5% retention less previously certified (sample: certified in full each time)
      const certified = (total - 0.05 * total) - (prevTotal - 0.05 * prevTotal);
      db.prepare('UPDATE claims SET certified_amt = ? WHERE id = ?').run(Math.round(certified * 100) / 100, cid);
    });
    // Claim 7 in draft for October
    const c7 = Number(claim.run(p1, 7, '2026-10-31', 'draft', '2026-11-05', null, null, null, U.wk, null).lastInsertRowid);
    const draft7 = { A2: 65600, A3: 107200, A4: 24600, A5: 41400, A6: 18600, A9: 17000 };
    Object.entries(S1).forEach(([code, id], idx) => line.run(c7, 'base', id, `${code} ${db.prepare('SELECT description d FROM sov_items WHERE id=?').get(id).d}`, db.prepare('SELECT amount a FROM sov_items WHERE id=?').get(id).a, cum[code][5], draft7[code] || 0, idx));
    [[10, 58000, 0], [11, 9850, 0], [12, 8900, 8900]].forEach(([n, prev, t], idx) => { const v = db.prepare('SELECT * FROM variations WHERE id=?').get(V1[n]); line.run(c7, 'variation', V1[n], `VO-0${n} ${v.title}`, v.approved_amt, prev, t, 1000 + idx); });
    att.run(p1, 'Labour', 'Wet fire labour tracking 6% over forecast — 3 weeks of overtime on risers', `#/projects/${p1}`, 'warn');
    att.run(p1, 'Sub', 'Hydraulics subcontractor claim #5 awaiting PM certification ($48,200)', `#/projects/${p1}`, 'info');

    // ---------- Project 2: Monash Health ward refurb (Wade) ----------
    const p2 = Number(proj.run(B.VIC, '26-0392', 'Monash Health — Ward 4 East refurbishment', 'Monash Health', 'Kane Constructions', U.wk, 1240000, 0.05, 0.05, 5, '2026-01-14', '2027-02-26', 0.16, 'live').lastInsertRowid);
    access.run(p2, U.wk, 'lead', U.jb, '2026-01-14 09:00:00'); access.run(p2, U.nk, 'member', U.jb, '2026-01-20 09:00:00');
    [['10', 'Design & engineering', 48000, 48000, 46100, 48000], ['20', 'Wet fire — labour', 186000, 0, 131000, 190000], ['21', 'Wet fire — materials', 298000, 291000, 236000, 295000], ['30', 'Dry fire — labour', 142000, 0, 88000, 140000], ['31', 'Dry fire — materials', 214000, 209000, 141000, 212000], ['50', 'Preliminaries', 112000, 0, 79000, 115000], ['60', 'Commissioning & defects', 42000, 0, 0, 42000]].forEach(c => cc.run(p2, ...c));
    const S2 = {}; [['A1', 'Design & approvals', 60000], ['A2', 'Wet fire — sprinkler modifications', 540000], ['A3', 'Dry fire — detection & nurse-call interface', 420000], ['A4', 'Commissioning & certification', 70000], ['A5', 'Preliminaries', 150000]].forEach((s, i) => { S2[s[0]] = Number(sov.run(p2, s[0], s[1], s[2], i).lastInsertRowid); });
    [['Design', 100], ['Wet fire', 68], ['Dry fire', 55], ['Commissioning', 0]].forEach((s, i) => stage.run(p2, s[0], s[1], i));
    const V2 = {};
    addVo(p2, V2, 1, 'Relocate 6 heads for revised ceiling grid', 'Design change', 'Wet fire', 'approved', 18, 2880, 1900, 0, 1200, 5980, 5980, 4600, 100, U.wk, 'SI-003', null, '2026-04-02', '2026-04-08', '2026-04-20');
    addVo(p2, V2, 2, 'Out-of-hours works — live ward adjacent', 'Delay / disruption', 'Wet fire', 'approved', 140, 25200, 0, 0, 5000, 30200, 27500, 26800, 100, U.wk, 'SI-007', 'Approved at reduced rate', '2026-06-15', '2026-06-22', '2026-07-14');
    addVo(p2, V2, 3, 'Additional detectors to new store rooms', 'Client instruction', 'Dry fire', 'submitted', 20, 3200, 2600, 0, 1450, 7250, null, 5800, 100, U.nk, 'SI-011', null, '2026-10-06', '2026-10-13', null);
    const c2a = Number(claim.run(p2, 1, '2026-09-30', 'certified', '2026-10-05', '2026-10-05', '2026-10-21', 0, U.wk, U.jb).lastInsertRowid);
    const cum2 = { A1: 60000, A2: 340000, A3: 210000, A4: 0, A5: 95000 };
    let t2 = 0; Object.entries(S2).forEach(([code, id], idx) => { line.run(c2a, 'base', id, `${code} ${db.prepare('SELECT description d FROM sov_items WHERE id=?').get(id).d}`, db.prepare('SELECT amount a FROM sov_items WHERE id=?').get(id).a, 0, cum2[code], idx); t2 += cum2[code]; });
    [[1, 5980], [2, 27500]].forEach(([n, a], idx) => { const v = db.prepare('SELECT * FROM variations WHERE id=?').get(V2[n]); line.run(c2a, 'variation', V2[n], `VO-00${n} ${v.title}`, a, 0, a, 1000 + idx); t2 += a; });
    db.prepare('UPDATE claims SET certified_amt = ? WHERE id = ?').run(Math.round(t2 * 0.95 * 100) / 100, c2a);

    // ---------- Project 3: Dandenong logistics shed (Nik) ----------
    const p3 = Number(proj.run(B.VIC, '26-0455', 'Dandenong South logistics facility — ESFR sprinklers', 'Goodman', 'Vaughan Constructions', U.nb, 2860000, 0.05, 0.05, 5, '2026-04-22', '2027-03-31', 0.14, 'live').lastInsertRowid);
    access.run(p3, U.nb, 'lead', U.jb, '2026-04-22 09:00:00'); access.run(p3, U.nk, 'member', U.jb, '2026-05-01 09:00:00');
    [['10', 'Design & engineering', 96000, 96000, 91000, 96000], ['20', 'Wet fire — labour', 520000, 0, 212000, 530000], ['21', 'Wet fire — materials', 1180000, 1164000, 611000, 1170000], ['40', 'Subcontract — tank & pumps', 420000, 420000, 180000, 420000], ['50', 'Preliminaries', 180000, 0, 74000, 182000], ['60', 'Commissioning & defects', 64000, 0, 0, 64000]].forEach(c => cc.run(p3, ...c));
    const S3 = {}; [['A1', 'Design & hydraulic calcs', 120000], ['A2', 'Tank, pumphouse & pumps', 620000], ['A3', 'ESFR mains & branch lines', 1480000], ['A4', 'Hydrants & hose reels', 340000], ['A5', 'Commissioning', 90000], ['A6', 'Preliminaries', 210000]].forEach((s, i) => { S3[s[0]] = Number(sov.run(p3, s[0], s[1], s[2], i).lastInsertRowid); });
    [['Design', 100], ['Tank & pumps', 45], ['ESFR mains', 38], ['Hydrants', 20], ['Commissioning', 0]].forEach((s, i) => stage.run(p3, s[0], s[1], i));
    const V3 = {};
    addVo(p3, V3, 1, 'Increase tank capacity per revised hazard classification', 'Design change', 'Wet fire', 'approved', 0, 0, 0, 68000, 10200, 78200, 78200, 68000, 100, U.nb, 'SI-002', null, '2026-06-10', '2026-06-17', '2026-07-01');
    addVo(p3, V3, 2, 'Rock excavation for tank footing', 'Latent condition', 'Wet fire', 'submitted', 0, 0, 0, 24500, 3700, 28200, null, 24500, 100, U.nb, 'NOD-001', null, '2026-09-30', '2026-10-07', null);
    const c3a = Number(claim.run(p3, 1, '2026-08-31', 'certified', '2026-09-04', '2026-09-04', '2026-09-22', 0, U.nb, U.jb).lastInsertRowid);
    const c3b = Number(claim.run(p3, 2, '2026-09-30', 'served', '2026-10-05', '2026-10-05', null, null, U.nb, U.jb).lastInsertRowid);
    const cum3a = { A1: 120000, A2: 155000, A3: 222000, A4: 0, A5: 0, A6: 52500 }; const cum3b = { A1: 120000, A2: 279000, A3: 562400, A4: 68000, A5: 0, A6: 84000 };
    let t3a = 0; Object.entries(S3).forEach(([code, id], idx) => { const amt = db.prepare('SELECT amount a FROM sov_items WHERE id=?').get(id).a; const d = db.prepare('SELECT description d FROM sov_items WHERE id=?').get(id).d; line.run(c3a, 'base', id, `${code} ${d}`, amt, 0, cum3a[code], idx); line.run(c3b, 'base', id, `${code} ${d}`, amt, cum3a[code], cum3b[code] - cum3a[code], idx); t3a += cum3a[code]; });
    { const v = db.prepare('SELECT * FROM variations WHERE id=?').get(V3[1]); line.run(c3b, 'variation', V3[1], `VO-001 ${v.title}`, 78200, 0, 78200, 1000); }
    db.prepare('UPDATE claims SET certified_amt = ? WHERE id = ?').run(Math.round(t3a * 0.95 * 100) / 100, c3a);

    // ---------- Project 4: Palmer Court workshop (Lachlan) — just awarded ----------
    const p4 = Number(proj.run(B.VIC, '26-0470', '8-10 Palmer Court, Mount Waverley — workshop & spray booth', '[Client]', '[Head contractor]', U.lg, 486000, 0.05, 0.05, 5, '2026-11-01', '2027-04-30', 0.18, 'live').lastInsertRowid);
    access.run(p4, U.lg, 'lead', U.jb, '2026-10-27 09:00:00'); access.run(p4, U.wk, 'readonly', U.jb, '2026-10-27 09:00:00');
    [['10', 'Design & engineering', 22000, 0, 0, 22000], ['20', 'Wet fire — labour', 96000, 0, 0, 96000], ['21', 'Wet fire — materials', 148000, 0, 0, 148000], ['30', 'Dry fire — labour', 38000, 0, 0, 38000], ['31', 'Dry fire — materials', 52000, 0, 0, 52000], ['50', 'Preliminaries', 42000, 0, 0, 42000]].forEach(c => cc.run(p4, ...c));
    [['A1', 'Design & DTS report', 30000], ['A2', 'Hydrants & hose reels', 160000], ['A3', 'Spray booth suppression', 150000], ['A4', 'Detection & EWIS', 96000], ['A5', 'Preliminaries', 50000]].forEach((s, i) => sov.run(p4, s[0], s[1], s[2], i));
    [['Design', 10], ['Wet fire', 0], ['Dry fire', 0], ['Commissioning', 0]].forEach((s, i) => stage.run(p4, s[0], s[1], i));

    // ---------- Project 5: Geelong aquatic (Matt) ----------
    const p5 = Number(proj.run(B.VIC, '26-0461', 'Geelong regional aquatic centre — fire services', 'City of Greater Geelong', 'ADCO', U.mm, 1980000, 0.05, 0.05, 5, '2026-05-09', '2027-06-30', 0.15, 'live').lastInsertRowid);
    access.run(p5, U.mm, 'lead', U.jb, '2026-05-09 09:00:00'); access.run(p5, U.wk, 'member', U.jb, '2026-05-09 09:00:00');
    [['10', 'Design & engineering', 78000, 78000, 70000, 78000], ['20', 'Wet fire — labour', 360000, 0, 98000, 362000], ['21', 'Wet fire — materials', 720000, 702000, 240000, 712000], ['30', 'Dry fire — labour', 190000, 0, 41000, 190000], ['31', 'Dry fire — materials', 260000, 251000, 88000, 258000], ['50', 'Preliminaries', 118000, 0, 39000, 118000], ['60', 'Commissioning & defects', 48000, 0, 0, 48000]].forEach(c => cc.run(p5, ...c));
    const S5 = {}; [['A1', 'Design & approvals', 95000], ['A2', 'Wet fire — mains, risers & sprinklers', 1120000], ['A3', 'Dry fire — detection & EWIS', 520000], ['A4', 'Commissioning', 65000], ['A5', 'Preliminaries', 180000]].forEach((s, i) => { S5[s[0]] = Number(sov.run(p5, s[0], s[1], s[2], i).lastInsertRowid); });
    [['Design', 95], ['Wet fire', 24], ['Dry fire', 15], ['Commissioning', 0]].forEach((s, i) => stage.run(p5, s[0], s[1], i));
    const c5 = Number(claim.run(p5, 1, '2026-09-30', 'certified', '2026-10-05', '2026-10-05', '2026-10-20', 0, U.mm, U.jb).lastInsertRowid);
    const cum5 = { A1: 85000, A2: 246000, A3: 78000, A4: 0, A5: 45000 }; let t5 = 0;
    Object.entries(S5).forEach(([code, id], idx) => { line.run(c5, 'base', id, `${code} ${db.prepare('SELECT description d FROM sov_items WHERE id=?').get(id).d}`, db.prepare('SELECT amount a FROM sov_items WHERE id=?').get(id).a, 0, cum5[code], idx); t5 += cum5[code]; });
    db.prepare('UPDATE claims SET certified_amt = ? WHERE id = ?').run(Math.round(t5 * 0.95 * 100) / 100, c5);

    // ---------- every other state, plus extra VIC jobs ----------
    require('./seed-branches').seedBranches(db, B, { bm: U.jb, pms: [U.wk, U.nb, U.mm, U.lg], sups: [U.nk], fin: U.fin });
    db.prepare("INSERT INTO audit_log (user_id, branch_id, action, detail) VALUES (NULL, ?, 'seed', 'Sample data loaded')").run(B.VIC);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { password: PW };
}

if (require.main === module) {
  const fs = require('node:fs');
  const { DB_PATH } = require('../src/db');
  if (process.argv.includes('--reset')) { for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f); console.log('Database reset.'); }
  const db = require('../src/db').open();
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n) { console.log('Database already has data — use --reset to wipe and re-seed.'); process.exit(0); }
  seed(db);
  console.log(`Seeded. All sample users sign in with password "${PW}". Try jayden.brown@premiersg.com.au (Branch Manager) or wade.kneale@premiersg.com.au (PM).`);
}

module.exports = { seed, PW };
