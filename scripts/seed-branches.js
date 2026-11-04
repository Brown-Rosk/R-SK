'use strict';
// Generates realistic multi-state sample data: users, jobs, cost codes, SOV, programme, variations and claims history.
// Deterministic (seeded PRNG) so the presentation numbers are stable between resets. ALL SAMPLE DATA.
const A = require('../src/auth');

let seedN = 42;
const rnd = () => { seedN = (seedN * 1103515245 + 12345) & 0x7fffffff; return seedN / 0x7fffffff; };
const between = (a, b) => a + rnd() * (b - a);
const r0 = (x) => Math.round(x);
const r100 = (x) => Math.round(x / 100) * 100;
const iso = (d) => d.toISOString().slice(0, 10);
const addM = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()));
const eom = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
const TODAY = new Date('2026-11-04');

const SOV_TEMPLATES = {
  fire: [['A1', 'Design, documentation & approvals', 0.04], ['A2', 'Wet fire — risers, mains & pumps', 0.18], ['A3', 'Wet fire — floor sprinkler rough-in', 0.27], ['A4', 'Wet fire — fit-off & heads', 0.09], ['A5', 'Dry fire — detection, FIP & cabling', 0.15], ['A6', 'Dry fire — EWIS & occupant warning', 0.07], ['A7', 'Hydrants, hose reels & extinguishers', 0.10], ['A8', 'Testing, commissioning & certification', 0.03], ['A9', 'Preliminaries', 0.07]],
  mech: [['A1', 'Design & engineering', 0.05], ['A2', 'Chillers, AHUs & plant', 0.28], ['A3', 'Ductwork & insulation', 0.22], ['A4', 'Pipework & hydronics', 0.15], ['A5', 'Controls & BMS', 0.10], ['A6', 'Fit-off, grilles & diffusers', 0.08], ['A7', 'Commissioning & balancing', 0.04], ['A8', 'Preliminaries', 0.08]],
  elec: [['A1', 'Design & engineering', 0.04], ['A2', 'Main switchboards & distribution', 0.22], ['A3', 'Cable reticulation & containment', 0.24], ['A4', 'Lighting & emergency lighting', 0.16], ['A5', 'Power & GPOs', 0.10], ['A6', 'Communications & security', 0.09], ['A7', 'Testing & commissioning', 0.04], ['A8', 'Preliminaries', 0.11]],
};
const COST_TEMPLATES = {
  fire: [['10', 'Design & engineering', 0.04], ['20', 'Wet fire — labour', 0.17], ['21', 'Wet fire — materials', 0.30], ['30', 'Dry fire — labour', 0.10], ['31', 'Dry fire — materials', 0.13], ['40', 'Subcontract — hydraulics', 0.14], ['50', 'Preliminaries', 0.09], ['60', 'Commissioning & defects', 0.03]],
  mech: [['10', 'Design & engineering', 0.05], ['20', 'Mechanical — labour', 0.22], ['21', 'Plant & equipment', 0.33], ['22', 'Ductwork & pipework materials', 0.18], ['40', 'Subcontract — controls', 0.09], ['50', 'Preliminaries', 0.10], ['60', 'Commissioning & defects', 0.03]],
  elec: [['10', 'Design & engineering', 0.04], ['20', 'Electrical — labour', 0.30], ['21', 'Switchboards & gear', 0.22], ['22', 'Cable & containment', 0.20], ['23', 'Luminaires & fittings', 0.10], ['50', 'Preliminaries', 0.11], ['60', 'Commissioning & defects', 0.03]],
};
const STAGES = { fire: ['Design', 'Wet fire — risers & mains', 'Wet fire — floor rough-in', 'Dry fire — detection & EWIS', 'Commissioning'], mech: ['Design', 'Plant install', 'Ductwork & pipework', 'Controls & BMS', 'Commissioning'], elec: ['Design', 'Switchboards & mains', 'Reticulation', 'Fit-off & lighting', 'Commissioning'] };
const VO_TITLES = {
  fire: ['Additional detection to revised tenancy layout', 'Relocate sprinkler mains around new services', 'Upgrade booster assembly to brigade requirement', 'Fire-rated penetrations — builder scope', 'Stop-work — standing time, unlevel slab', 'Extended hours per builder programme', 'Additional hydrant to loading dock per RFI', 'Change of pipe spec — galv to black steel', 'EWIS speakers to revised layout', 'Latent condition — rock excavation for tank'],
  mech: ['Additional VAV boxes to revised fit-out', 'Relocate AHU-3 per structural clash', 'Upgrade chiller capacity per revised load', 'Extended hours — live building', 'Additional BMS points per client instruction', 'Re-route duct around new transfer beam', 'Kitchen exhaust upgrade per revised tenancy', 'Standing time — delayed structure'],
  elec: ['Additional sub-board to revised tenancy', 'Upgrade main switchboard per revised load', 'Relocate cable tray per services clash', 'Additional emergency lighting per audit', 'Extended hours — occupied building', 'Additional data outlets per client instruction', 'Generator interface per revised brief', 'Standing time — delayed slab'],
};
const SOURCES = ['Client instruction', 'RFI response', 'Latent condition', 'Design change', 'Delay / disruption'];

function makeUsers(db, branchId, bm, pms, supervisors, finance, companyId, domain = 'premiersg.com.au') {
  const ins = db.prepare('INSERT OR IGNORE INTO users (company_id, email, name, initials, password_hash) VALUES (?,?,?,?,?)');
  const get = db.prepare('SELECT id FROM users WHERE email = ?');
  const mem = db.prepare('INSERT OR REPLACE INTO branch_members (user_id, branch_id, role) VALUES (?,?,?)');
  const mk = (name, role) => {
    const email = name.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.') + '@' + domain;
    const initials = name.replace(/[^A-Za-z ]/g, '').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    ins.run(companyId, email, name, initials, A.hashPassword('psg2026'));
    const id = get.get(email).id; mem.run(id, branchId, role); return id;
  };
  return { bm: mk(bm, 'branch_manager'), pms: pms.map(n => mk(n, 'pm')), sups: supervisors.map(n => mk(n, 'supervisor')), fin: finance ? mk(finance, 'finance') : null };
}

// spec: { number, name, client, hc, type, value, margin, pct, start, months, pmIdx, status? }
function makeProject(db, branchId, users, spec) {
  const pmId = users.pms[spec.pmIdx % users.pms.length];
  const start = new Date(spec.start); const pc = addM(start, spec.months);
  const status = spec.status || 'live';
  const disc = { fire: 'fire', mech: 'mechanical', elec: 'electrical' }[spec.type] || 'fire';
  const pid = Number(db.prepare(`INSERT INTO projects (branch_id, number, name, client, head_contractor, lead_pm_id, contract_value, retention_pct, retention_cap_pct, claim_day, start_date, pc_date, tender_margin_pct, status, discipline)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(branchId, spec.number, spec.name, spec.client, spec.hc, pmId, spec.value, 0.05, 0.05, 5, iso(start), iso(pc), spec.margin, status, status === 'live' || true ? disc : disc).lastInsertRowid);
  const grant = db.prepare('INSERT OR REPLACE INTO project_access (project_id, user_id, level, granted_by, granted_at) VALUES (?,?,?,?,?)');
  grant.run(pid, pmId, 'lead', users.bm, iso(start) + ' 09:00:00');
  if (users.sups.length) grant.run(pid, users.sups[spec.pmIdx % users.sups.length], 'member', users.bm, iso(start) + ' 09:00:00');
  const t = spec.type; const pct = status === 'live' ? spec.pct : 0;

  // cost codes: forecast = value*(1-margin) with drift; actual = forecast * pct * noise
  const drift = between(-0.015, 0.03); // margin erosion/gain
  const costLag = between(0.78, 0.98); // cost in Sage lags site progress a little
  const claimBias = rnd() < 0.3 ? between(1.18, 1.4) : between(0.95, 1.08); // ~28% of jobs claim ahead of work done
  const costTotal = spec.value * (1 - spec.margin);
  const cc = db.prepare('INSERT INTO cost_codes (project_id, code, name, budget, committed, actual, forecast) VALUES (?,?,?,?,?,?,?)');
  COST_TEMPLATES[t].forEach(([code, name, share]) => {
    const budget = r100(costTotal * share); const forecast = r100(budget * (1 + drift * between(0.3, 1.8)));
    const isMat = /materials|Plant|gear|Cable|Luminaires|Subcontract/.test(name);
    const actual = r100(forecast * Math.min(1, pct * costLag * between(0.95, 1.05)) * (code === '60' ? (pct > 0.9 ? 0.5 : 0.05) : 1));
    cc.run(pid, code, name, budget, isMat && pct > 0 ? r100(forecast * between(0.92, 1)) : 0, actual, forecast);
  });
  // SOV
  const sov = db.prepare('INSERT INTO sov_items (project_id, code, description, amount, sort) VALUES (?,?,?,?,?)');
  const sovRows = []; let acc = 0;
  SOV_TEMPLATES[t].forEach(([code, desc, share], i, arr) => { const amt = i === arr.length - 1 ? spec.value - acc : r100(spec.value * share); acc += amt; sovRows.push({ id: Number(sov.run(pid, code, desc, amt, i).lastInsertRowid), code, desc, amt, i }); });
  // programme: stages progress in sequence according to pct
  const st = db.prepare('INSERT INTO programme_stages (project_id, name, pct_complete, sort) VALUES (?,?,?,?)');
  STAGES[t].forEach((name, i, arr) => { const lo = i / arr.length, hi = (i + 1) / arr.length; const p = pct <= lo ? 0 : pct >= hi ? 100 : (pct - lo) / (hi - lo) * 100; st.run(pid, name, r0(Math.min(100, p * (i === 0 ? 1.4 : 1))), i); });
  if (status !== 'live') return pid;

  // variations
  const vo = db.prepare(`INSERT INTO variations (project_id, number, title, source, discipline, status, labour_hours, labour_amt, materials_amt, sub_plant_amt, prelims_margin_amt, submitted_amt, approved_amt, cost_to_date, pct_done, owner_id, client_ref, raised_at, submitted_at, approved_at, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const nVo = Math.max(2, r0(pct * 10 * between(0.7, 1.3)));
  const approvedVos = []; const titles = VO_TITLES[t];
  for (let n = 1; n <= nVo; n++) {
    const amt = r100(spec.value * between(0.003, 0.02)); const lab = r100(amt * between(0.2, 0.45)); const mat = r100(amt * between(0.25, 0.5)); const sub = n % 4 === 0 ? r100(amt * 0.15) : 0; const pm = amt - lab - mat - sub;
    const raised = addM(start, r0(between(1, Math.max(1, spec.months * pct - 0.5)))); const subAt = addM(raised, 0); subAt.setUTCDate(subAt.getUTCDate() + r0(between(5, 12)));
    const age = (TODAY - subAt) / 86400000;
    let status, approved = null, appAt = null;
    const roll = rnd();
    if (age < 0) status = 'draft'; else if (age < 25) status = roll < 0.3 ? 'priced' : 'submitted'; else if (roll < 0.62) status = 'approved'; else if (roll < 0.78) status = 'submitted'; else if (roll < 0.9) status = 'disputed'; else status = 'rejected';
    if (status === 'approved') { approved = r100(amt * between(0.85, 1)); appAt = new Date(subAt); appAt.setUTCDate(appAt.getUTCDate() + r0(between(14, 40))); }
    const submitted = status === 'draft' ? 0 : amt;
    const done = status === 'draft' ? between(0.3, 1) : 1;
    const id = Number(vo.run(pid, n, titles[(n - 1) % titles.length], SOURCES[n % SOURCES.length], t === 'fire' ? (n % 3 ? 'Wet fire' : 'Dry fire') : t === 'mech' ? 'Mechanical' : 'Electrical', status, r0(lab / 160), lab, mat, sub, pm, submitted, status === 'rejected' ? 0 : approved, r100((lab + mat + sub) * between(0.8, 1.05) * done), r0(done * 100), pmId, (n % 3 ? 'SI-' : 'RFI-') + String(10 + n * 3).padStart(3, '0'), iso(raised), status === 'draft' ? null : iso(subAt), appAt ? iso(appAt) : null, appAt ? iso(appAt) : (status === 'rejected' ? iso(subAt) : null)).lastInsertRowid);
    if (status === 'approved') approvedVos.push({ id, n, title: titles[(n - 1) % titles.length], amt: approved, appAt });
  }

  // claims: one per month from first month-end after start until last month-end before today; last one 'served', current month draft
  const claim = db.prepare('INSERT INTO claims (project_id, number, period_end, status, serve_by, served_at, certified_at, certified_amt, drafted_by, approved_by, payment_due) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const line = db.prepare('INSERT INTO claim_lines (claim_id, kind, ref_id, description, contract_amt, prev_claimed, this_claim, sort) VALUES (?,?,?,?,?,?,?,?)');
  const periods = []; let pe = eom(start);
  while (pe < new Date('2026-10-01T00:00:00Z')) { periods.push(pe); pe = eom(addM(pe, 1)); }
  const lineProgress = sovRows.map((s, i) => { const lo = i / sovRows.length * 0.9, span = 0.45; return (p) => s.code === 'A1' ? Math.min(1, p * 3) : Math.max(0, Math.min(1, (p - lo) / span)); });
  const totalMonths = spec.months; const prevCum = sovRows.map(() => 0); const prevVo = new Map(); let prevCert = 0; let prevCumTotal = 0;
  periods.forEach((pend, i) => {
    const monthsIn = (pend - start) / (86400000 * 30.4); const p = Math.min(1, Math.min(pct, monthsIn / totalMonths * (pct / Math.max(0.05, Math.min(1, ((TODAY - start) / (86400000 * 30.4)) / totalMonths)))) * claimBias);
    const isLast = i === periods.length - 1;
    const served = new Date(Date.UTC(pend.getUTCFullYear(), pend.getUTCMonth() + 1, 4)); const cert = new Date(served); cert.setUTCDate(cert.getUTCDate() + 18);
    const status = isLast ? 'served' : 'certified';
    const cid = Number(claim.run(pid, i + 1, iso(pend), status, iso(served), iso(served), status === 'certified' ? iso(cert) : null, null, pmId, users.bm, iso(cert)).lastInsertRowid);
    let cumTotal = 0;
    sovRows.forEach((s, k) => { const cum = r100(s.amt * lineProgress[k](p)); const t = Math.max(0, cum - prevCum[k]); line.run(cid, 'base', s.id, `${s.code} ${s.desc}`, s.amt, prevCum[k], t, k); prevCum[k] += t; cumTotal += prevCum[k]; });
    approvedVos.filter(v => v.appAt <= pend).forEach((v, k) => { const prev = prevVo.get(v.id) || 0; const t = v.amt - prev; line.run(cid, 'variation', v.id, `VO-${String(v.n).padStart(3, '0')} ${v.title}`, v.amt, prev, t, 1000 + k); prevVo.set(v.id, v.amt); cumTotal += v.amt; });
    const retention = Math.min(0.05 * spec.value, 0.05 * cumTotal);
    const amountExGst = cumTotal - retention - prevCert;
    if (status === 'certified') { const certAmt = r0(amountExGst * (rnd() < 0.15 ? between(0.9, 0.99) : 1)); db.prepare('UPDATE claims SET certified_amt = ? WHERE id = ?').run(certAmt, cid); prevCert += certAmt; }
    prevCumTotal = cumTotal;
  });
  // current draft claim (period ending 31 Oct 2026 → serve by 5 Nov) if the last served one was September or earlier
  if (!periods.length || iso(periods[periods.length - 1]) < '2026-10-31') {
    const cid = Number(claim.run(pid, periods.length + 1, '2026-10-31', rnd() < 0.35 ? 'internal_review' : 'draft', '2026-11-05', null, null, null, pmId, null, null).lastInsertRowid);
    sovRows.forEach((s, k) => { const target = r100(s.amt * lineProgress[k](pct)); line.run(cid, 'base', s.id, `${s.code} ${s.desc}`, s.amt, prevCum[k], Math.max(0, target - prevCum[k]), k); });
    approvedVos.forEach((v, k) => { const prev = prevVo.get(v.id) || 0; line.run(cid, 'variation', v.id, `VO-${String(v.n).padStart(3, '0')} ${v.title}`, v.amt, prev, v.amt - prev, 1000 + k); });
  }
  return pid;
}

const P = (number, name, client, hc, type, valueM, margin, pct, start, months, pmIdx, status) => ({ number, name, client, hc, type, value: r100(valueM * 1e6), margin, pct, start, months, pmIdx, status });

const BRANCH_DATA = {
  QLD: { bm: 'Daniel Reyes', pms: ['Sophie Marsh', 'Liam Okafor', 'Georgia Tran', 'Ben Halloran'], sups: ['Mitch Carey', 'Aaron Pike'], fin: 'Finance (QLD)', offices: 'Brisbane · Gold Coast · Sunshine Coast', projects: [
    P('QLD-26-0112', 'Queen Street Precinct — Tower A fire services', 'Dexus', 'Multiplex', 'fire', 14.2, 0.14, 0.46, '2026-01-12', 24, 0),
    P('QLD-26-0118', 'Gold Coast University Hospital — Stage 3 mechanical', 'QLD Health', 'Lendlease', 'mech', 12.8, 0.13, 0.38, '2026-03-02', 22, 1),
    P('QLD-25-0097', 'Brisbane Olympic Village — Precinct 2 electrical', 'Economic Development QLD', 'Hutchinson Builders', 'elec', 9.6, 0.145, 0.62, '2025-09-15', 20, 2),
    P('QLD-26-0121', 'Sunshine Coast logistics hub — ESFR sprinklers', 'Charter Hall', 'FDC', 'fire', 6.4, 0.15, 0.31, '2026-05-04', 14, 3),
    P('QLD-25-0088', 'Townsville Hospital — ED expansion fire & mech', 'QLD Health', 'Watpac', 'fire', 7.9, 0.14, 0.78, '2025-06-02', 20, 0),
    P('QLD-26-0125', 'Brisbane Airport — Terminal 3 electrical upgrade', 'Brisbane Airport Corp', 'John Holland', 'elec', 5.3, 0.15, 0.22, '2026-07-06', 16, 1),
    P('QLD-26-0119', 'Robina mixed-use — Stages 1–2 fire services', 'Robina Group', 'Hutchinson Builders', 'fire', 4.1, 0.16, 0.41, '2026-02-16', 18, 2),
    P('QLD-26-0130', 'Ipswich data centre — mechanical cooling', 'NEXTDC', 'Kapitol Group', 'mech', 0.0 + 2.4, 0.13, 0.12, '2026-09-01', 12, 3),
  ] },
  NSW: { bm: 'Rachel Donovan', pms: ['Tom Whitfield', 'Priya Nair', 'Jack Moloney', 'Elena Rossi'], sups: ['Sam Burke', 'Kyle Hennessy'], fin: 'Finance (NSW)', offices: 'Sydney · Parramatta · Newcastle', projects: [
    P('NSW-25-0241', 'Western Sydney Airport — Terminal fire services', 'WSA Co', 'Multiplex', 'fire', 16.5, 0.13, 0.58, '2025-04-07', 26, 0),
    P('NSW-26-0266', 'Central Place Sydney — Tower 1 mechanical', 'Dexus / Frasers', 'Lendlease', 'mech', 11.2, 0.135, 0.33, '2026-02-02', 24, 1),
    P('NSW-26-0259', 'Bradfield City Centre — Stage 1 electrical', 'WPCA', 'Richard Crookes', 'elec', 8.4, 0.14, 0.44, '2025-11-17', 20, 2),
    P('NSW-26-0271', 'Parramatta Square — Building 8 fire & electrical', 'Walker Corp', 'Built', 'fire', 6.1, 0.15, 0.29, '2026-04-13', 18, 3),
    P('NSW-25-0236', 'John Hunter Hospital — Stage 2 mechanical', 'NSW Health Infrastructure', 'John Holland', 'mech', 5.8, 0.14, 0.81, '2025-05-05', 20, 0),
    P('NSW-26-0280', 'Macquarie Park life-sciences — fire services', 'Charter Hall', 'Hansen Yuncken', 'fire', 3.2, 0.16, 0.18, '2026-08-03', 14, 1),
    P('NSW-26-0268', 'Newcastle logistics estate — Sheds 3–5 fire', 'Goodman', 'Vaughan Constructions', 'fire', 1.9, 0.17, 0.52, '2026-03-16', 12, 2),
  ] },
  WA: { bm: 'Tyson (WA)', pms: ['Harrison Cole', 'Mia Lindqvist'], sups: ['Dylan Ward'], fin: 'Finance (WA)', offices: 'Perth · Kwinana', projects: [
    P('WA-26-0014', 'Perth Children’s Hospital — Ward upgrades fire & mech', 'WA Health', 'Multiplex', 'fire', 7.6, 0.14, 0.24, '2026-06-01', 18, 0),
    P('WA-26-0011', 'Elizabeth Quay — Tower 2 mechanical', 'Brookfield', 'Probuild WA', 'mech', 6.3, 0.13, 0.19, '2026-07-13', 22, 1),
    P('WA-26-0017', 'Kwinana lithium refinery — electrical reticulation', 'Covalent Lithium', 'Monadelphous', 'elec', 4.4, 0.15, 0.11, '2026-09-07', 14, 0),
    P('WA-26-0009', 'Joondalup Health Campus — detection upgrade', 'Ramsay Health', 'Georgiou', 'fire', 1.8, 0.16, 0.37, '2026-05-18', 10, 1),
  ] },
  SA: { bm: 'Nathan Pavlou', pms: ['Chloe Baxter', 'Omar Haddad'], sups: ['Ryan Tate'], fin: 'Finance (SA)', offices: 'Adelaide', projects: [
    P('SA-25-0063', 'New Women’s & Children’s Hospital — fire services', 'SA Health', 'Lendlease', 'fire', 6.8, 0.135, 0.49, '2025-10-06', 24, 0),
    P('SA-26-0071', 'Lot Fourteen — Innovation Tower mechanical', 'Renewal SA', 'Hansen Yuncken', 'mech', 2.9, 0.14, 0.27, '2026-04-20', 16, 1),
    P('SA-26-0075', 'Osborne naval shipyard — Building 7 electrical', 'ANI', 'Laing O’Rourke', 'elec', 1.6, 0.15, 0.15, '2026-08-10', 12, 0),
  ] },
  TAS: { bm: 'Fiona McLeod', pms: ['Angus Reid'], sups: [], fin: null, offices: 'Hobart · Launceston', projects: [
    P('TAS-26-0021', 'Royal Hobart Hospital — Stage 2 fire upgrade', 'TAS Health', 'Fairbrother', 'fire', 3.4, 0.145, 0.42, '2026-02-09', 18, 0),
    P('TAS-26-0024', 'Launceston General — mechanical plant replacement', 'TAS Health', 'Vos Construction', 'mech', 1.7, 0.14, 0.33, '2026-05-11', 12, 0),
  ] },
  NZ: { bm: 'Hemi Walker', pms: ['Aroha Ngata', 'Callum Fraser', 'Jess Patel'], sups: ['Luke Harper'], fin: 'Finance (NZ)', offices: 'Auckland · Wellington · Dunedin', projects: [
    P('NZ-26-0038', 'Dunedin Hospital — Inpatient building fire services', 'Te Whatu Ora', 'CPB / Fletcher', 'fire', 6.9, 0.13, 0.36, '2026-01-19', 26, 2),
    P('NZ-25-0031', 'Auckland CRL — Aotea Station electrical fit-out', 'City Rail Link Ltd', 'Link Alliance', 'elec', 4.2, 0.14, 0.71, '2025-08-04', 18, 0),
    P('NZ-26-0042', 'Wellington Airport — terminal mechanical upgrade', 'WIAL', 'Hawkins', 'mech', 2.6, 0.145, 0.24, '2026-06-15', 14, 1),
  ] },
};

// Extra VIC jobs to bring VIC to ~$32M alongside the hand-built ones.
const VIC_EXTRA = [
  P('26-0401', 'Melbourne Airport — Terminal 2 fire upgrade', 'Australia Pacific Airports', 'Kane Constructions', 'fire', 8.9, 0.14, 0.44, '2026-01-27', 22, 0),
  P('26-0438', 'Footscray Hospital — mechanical services package', 'VHBA', 'Multiplex', 'mech', 6.2, 0.135, 0.52, '2025-11-10', 20, 1),
  P('26-0449', 'Docklands Tower 5 — electrical services', 'Lendlease', 'Lendlease', 'elec', 3.7, 0.145, 0.31, '2026-04-06', 16, 2),
  P('26-0466', 'Geelong Convention Centre — fire & electrical', 'Development Victoria', 'Plenary / Built', 'fire', 1.5, 0.15, 0.2, '2026-08-24', 12, 3),
  P('T-26-0480', '640 Bourke Street — tower fire services (tender)', 'Far East Consortium', '[TBC]', 'fire', 9.8, 0.145, 0, '2027-02-01', 26, 0, 'tender'),
];

function seedBranches(db, B, vicUsers, companyId) {
  for (const [code, d] of Object.entries(BRANCH_DATA)) {
    const bid = B[code];
    db.prepare("UPDATE branches SET status = 'live', offices = ? WHERE id = ?").run(d.offices, bid);
    const users = makeUsers(db, bid, d.bm, d.pms, d.sups, d.fin, companyId);
    d.projects.forEach(p => makeProject(db, bid, users, p));
  }
  VIC_EXTRA.forEach(p => makeProject(db, B.VIC, vicUsers, p));
}

// A second, small customer: one-branch hydraulics & fire contractor, ~15 staff, so the product visibly isn't sized only for a group.
function seedSecondCompany(db, companyId) {
  const bid = Number(db.prepare("INSERT INTO branches (company_id, code, name, country, currency, gst_rate, offices, job_prefix, status, vo_approval_threshold) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(companyId, 'SYD', 'Sydney', 'AU', 'AUD', 0.10, 'Botany', 'HH', 'live', 10000).lastInsertRowid);
  const users = makeUsers(db, bid, 'Marcus Delaney', ['Kate Sutherland', 'Josh Pereira'], ['Dean Castillo'], 'Accounts (Harbourline)', companyId, 'harbourlinehydraulics.com.au');
  // directors: Marcus is also the owner → group admin
  db.prepare('UPDATE users SET is_group_admin = 1 WHERE id = ?').run(users.bm);
  [
    P('HH-26-0142', 'Mascot industrial estate — hydrants & hose reels', 'Goodman', 'Vaughan Constructions', 'fire', 2.1, 0.17, 0.55, '2026-03-02', 12, 0),
    P('HH-26-0147', 'Alexandria apartments — Stage 2 sprinklers', 'Meriton', 'Meriton', 'fire', 1.6, 0.16, 0.38, '2026-05-18', 12, 1),
    P('HH-26-0151', 'Botany cold store — ESFR upgrade', 'Lineage', 'Total Construction', 'fire', 0.9, 0.18, 0.24, '2026-08-03', 8, 0),
    P('HH-26-0139', 'Randwick school hall — fire services', 'NSW Dept of Education', 'Buildcorp', 'fire', 0.6, 0.19, 0.86, '2026-02-09', 9, 1),
  ].forEach(p => makeProject(db, bid, users, p));
  db.prepare("UPDATE projects SET discipline = 'hydraulic' WHERE branch_id = ? AND number IN ('HH-26-0142','HH-26-0139')").run(bid);
}

module.exports = { seedBranches, seedSecondCompany, BRANCH_DATA, VIC_EXTRA };
