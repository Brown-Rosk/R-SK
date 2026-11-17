'use strict';
// Permission boundary tests — the ones that matter for "a PM only sees their jobs".
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DB = path.join(__dirname, 'tmp-test.sqlite');
for (const f of [DB, DB + '-wal', DB + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
process.env.PSG_DB = DB;
const { buildApp } = require('../server');
const { createServer } = require('../src/http');
const { seed } = require('../scripts/seed');

let server, base;
const login = async (email) => {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'psg2026' }) });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
};
const call = async (cookie, p, method = 'GET', body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const enter = (cookie, branch_id) => call(cookie, '/api/auth/branch', 'POST', { branch_id });

before(async () => {
  const { router, db } = buildApp(DB); seed(db);
  server = createServer(router); await new Promise(res => server.listen(0, res));
  base = 'http://localhost:' + server.address().port;
});
after(() => { server.close(); for (const f of [DB, DB + '-wal', DB + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f); });

test('unauthenticated requests are refused', async () => {
  assert.equal((await call('', '/api/projects')).status, 401);
  assert.equal((await call('', '/api/dashboard')).status, 401);
});

test('a PM sees only granted jobs, and other jobs 404 (not 403)', async () => {
  const wade = await login('wade.kneale@premiersg.com.au'); await enter(wade, 1);
  const ps = (await call(wade, '/api/projects')).body;
  for (const n of ['26-0392', '26-0417', '26-0461', '26-0470']) assert.ok(ps.some(p => p.number === n), n);
  assert.ok(!ps.some(p => p.number === '26-0455'), 'must not see Nik\'s job');
  const nik = (await call(wade, '/api/projects/3'));
  assert.equal(nik.status, 404);
  assert.equal((await call(wade, '/api/variations?project_id=3')).body.variations.length, 0);
  assert.equal((await call(wade, '/api/projects/3/variations', 'POST', { title: 'x' })).status, 404);
});

test('read-only access cannot write', async () => {
  const wade = await login('wade.kneale@premiersg.com.au'); await enter(wade, 1);
  const palmer = (await call(wade, '/api/projects')).body.find(p => p.number === '26-0470');
  assert.equal(palmer.access_level, 'readonly');
  assert.equal((await call(wade, `/api/projects/${palmer.id}/variations`, 'POST', { title: 'nope' })).status, 403);
});

test('branch manager sees every job; finance is read-only', async () => {
  const jb = await login('jayden.brown@premiersg.com.au'); await enter(jb, 1);
  const all = (await call(jb, '/api/projects')).body.length;
  const wade = await login('wade.kneale@premiersg.com.au'); await enter(wade, 1);
  assert.ok(all > (await call(wade, '/api/projects')).body.length);
  const fin = await login('finance@premiersg.com.au'); await enter(fin, 1);
  assert.equal((await call(fin, '/api/projects')).body.length, all);
  assert.equal((await call(fin, '/api/projects/1/variations', 'POST', { title: 'nope' })).status, 403);
});

test('branch boundary: a user cannot enter a branch they are not a member of', async () => {
  const wade = await login('wade.kneale@premiersg.com.au');
  assert.equal((await enter(wade, 3)).status, 403);
  assert.equal((await enter(wade, null)).status, 403); // group view
  const jb = await login('jayden.brown@premiersg.com.au');
  assert.equal((await enter(jb, 4)).status, 200); // WA — member
  assert.ok((await call(jb, '/api/projects')).body.every(p => p.number.startsWith('WA-'))); // only WA jobs
  assert.equal((await call(jb, '/api/projects/1')).status, 404); // VIC job invisible from WA
  assert.equal((await call(jb, '/api/group/overview')).status, 403);
});

test('director: group view and any branch', async () => {
  const d = await login('director@premiersg.com.au');
  assert.equal((await enter(d, null)).status, 200);
  const g = (await call(d, '/api/group/overview')).body;
  assert.equal(g.branches.length, 7);
  assert.equal(g.branches[0].code, 'QLD'); // largest first
  assert.ok(g.branches[0].totals.contract > 10e6);
  assert.ok(g.group.contract > 150e6 && g.group.contract < 250e6);
  await enter(d, 1);
  assert.ok((await call(d, '/api/projects')).body.length >= 5);
});

test('variation workflow and approval threshold', async () => {
  const wade = await login('wade.kneale@premiersg.com.au'); await enter(wade, 1);
  const v = (await call(wade, '/api/projects/1/variations', 'POST', { title: 'Big one', labour_amt: 20000, materials_amt: 10000 })).body;
  assert.equal(v.status, 'draft');
  assert.equal((await call(wade, `/api/variations/${v.id}/transition`, 'POST', { to: 'submitted' })).status, 409); // must be priced first
  assert.equal((await call(wade, `/api/variations/${v.id}/transition`, 'POST', { to: 'priced' })).body.status, 'priced');
  const sub = await call(wade, `/api/variations/${v.id}/transition`, 'POST', { to: 'submitted' });
  assert.equal(sub.status, 403); // $30k > $25k threshold → BM only
  const jb = await login('jayden.brown@premiersg.com.au'); await enter(jb, 1);
  assert.equal((await call(jb, `/api/variations/${v.id}/transition`, 'POST', { to: 'submitted' })).body.status, 'submitted');
  const ap = (await call(wade, `/api/variations/${v.id}/transition`, 'POST', { to: 'approved', amount: 28000 })).body;
  assert.equal(ap.status, 'approved'); assert.equal(ap.approved_amt, 28000);
  assert.equal((await call(wade, `/api/variations/${v.id}`, 'DELETE')).status, 409);
  // supervisor can raise but not submit
  const nk = await login('nathan.kurzemnieks@premiersg.com.au'); await enter(nk, 1);
  const sv = (await call(nk, '/api/projects/1/variations', 'POST', { title: 'Site raised', labour_amt: 1000 })).body;
  await call(nk, `/api/variations/${sv.id}/transition`, 'POST', { to: 'priced' });
  assert.equal((await call(nk, `/api/variations/${sv.id}/transition`, 'POST', { to: 'submitted' })).status, 403);
});

test('claim maths, checks and approval chain', async () => {
  const wade = await login('wade.kneale@premiersg.com.au'); await enter(wade, 1);
  const c = (await call(wade, '/api/claims/7')).body;
  const s = c.summary;
  assert.equal(c.lines.length, 9 + c.lines.filter(l => l.kind === 'variation').length);
  // retention 5% of cumulative, within 5% cap; GST 10%
  assert.ok(Math.abs(s.retention_held - Math.min(0.05 * s.contract_total, 0.05 * s.cumulative)) < 0.01);
  assert.ok(Math.abs(s.gst - s.amount_ex_gst * 0.10) < 0.01);
  assert.ok(Math.abs(s.amount_ex_gst - (s.cumulative - s.retention_held - s.prev_certified)) < 0.01);
  // over-claim a line → failing check → cannot submit for review
  const a8 = c.lines.find(l => l.description.startsWith('A8'));
  await call(wade, '/api/claims/7/lines', 'PUT', { lines: [{ kind: 'base', ref_id: a8.ref_id, this_claim: 999999 }] });
  const bad = await call(wade, '/api/claims/7/transition', 'POST', { to: 'internal_review' });
  assert.equal(bad.status, 409); assert.ok(bad.body.checks.length >= 1);
  await call(wade, '/api/claims/7/lines', 'PUT', { lines: [{ kind: 'base', ref_id: a8.ref_id, pct: 0 }] });
  assert.equal((await call(wade, '/api/claims/7/transition', 'POST', { to: 'internal_review' })).body.status, 'internal_review');
  assert.equal((await call(wade, '/api/claims/7/transition', 'POST', { to: 'approved' })).status, 403);
  const jb = await login('jayden.brown@premiersg.com.au'); await enter(jb, 1);
  assert.equal((await call(jb, '/api/claims/7/transition', 'POST', { to: 'approved' })).body.status, 'approved');
  const served = (await call(wade, '/api/claims/7/transition', 'POST', { to: 'served' })).body;
  assert.equal(served.status, 'served'); assert.ok(served.payment_due > served.served_at);
  assert.equal((await call(wade, '/api/claims/7/lines', 'PUT', { lines: [] })).status, 409); // locked
  const fin = await login('finance@premiersg.com.au'); await enter(fin, 1);
  const cert = (await call(fin, '/api/claims/7/transition', 'POST', { to: 'certified', certified_amt: served.summary.amount_ex_gst - 5000 })).body;
  assert.equal(cert.status, 'certified');
  const att = (await call(jb, '/api/projects/1')).body.attention;
  assert.ok(att.some(a => a.tag === 'Shortfall'));
  // next claim's previously-claimed picks up claim 7
  const c8 = (await call(wade, '/api/projects/1/claims', 'POST', { period_end: '2026-11-30' })).body;
  assert.equal(c8.number, 8);
  const a2 = c8.lines.find(l => l.description.startsWith('A2'));
  assert.equal(a2.prev_claimed, 574000 + 65600);
});

test('job grants and audit trail', async () => {
  const jb = await login('jayden.brown@premiersg.com.au'); await enter(jb, 1);
  const wade = await login('wade.kneale@premiersg.com.au'); await enter(wade, 1);
  const wid = (await call(jb, '/api/branch/users')).body.find(u => u.email.startsWith('wade')).id;
  assert.equal((await call(wade, '/api/projects/3')).status, 404);
  assert.equal((await call(jb, '/api/projects/3/access', 'POST', { user_id: wid, level: 'readonly' })).status, 200);
  assert.equal((await call(wade, '/api/projects/3')).status, 200);
  assert.equal((await call(jb, `/api/projects/3/access/${wid}`, 'DELETE')).status, 200);
  assert.equal((await call(wade, '/api/projects/3')).status, 404);
  assert.equal((await call(wade, '/api/projects/1/access', 'POST', { user_id: wid, level: 'lead' })).status, 403); // PM cannot grant
  const log = (await call(jb, '/api/audit')).body;
  assert.ok(log.some(l => l.action === 'access.grant') && log.some(l => l.action === 'access.revoke'));
  assert.equal((await call(wade, '/api/audit')).status, 403);
});

test('company boundary: tenants are isolated; platform admin can enter any company', async () => {
  const marcus = await login('marcus.delaney@harbourlinehydraulics.com.au');
  const me = (await call(marcus, '/api/me')).body;
  assert.equal(me.company.short_name, 'Harbourline');
  assert.equal(me.branches.length, 1); // only his own company's branch is listed
  assert.equal((await enter(marcus, 1)).status, 403); // PSG's VIC branch — refused
  await enter(marcus, me.branches[0].id);
  assert.ok((await call(marcus, '/api/projects')).body.every(p => p.number.startsWith('HH-')));
  assert.equal((await call(marcus, '/api/projects/1')).status, 404);
  await enter(marcus, null); // owner is a director of his company
  assert.equal((await call(marcus, '/api/group/overview')).body.branches.length, 1);
  assert.equal((await call(marcus, '/api/platform/companies')).status, 403);
  const admin = await login('admin@rosk.app');
  const cos = (await call(admin, '/api/platform/companies')).body;
  assert.equal(cos.length, 2); assert.equal(cos[0].short_name, 'PSG');
  assert.equal((await call(admin, '/api/group/overview')).status, 403); // no company entered yet
  await call(admin, '/api/auth/company', 'POST', { company_id: cos[1].id });
  assert.equal((await call(admin, '/api/group/overview')).body.company.short_name, 'Harbourline');
});

test('timesheets: clock in/out costs against the state rate, approval flows to job labour', async () => {
  const jb = await login('jayden.brown@premiersg.com.au'); await enter(jb, 1);
  const staff = (await call(jb, '/api/staff')).body; const worker = staff.find(u => u.employment_type === 'wages' && u.home_branch === 'VIC' && !/Kurzemnieks/.test(u.name));
  const w = await login(worker.email); await enter(w, 1);
  const me = (await call(w, '/api/timesheets/me')).body; assert.ok(me.jobs.length >= 1);
  const pid = me.jobs[0].id;
  // manual 9.6 h weekday entry → 7.6 ordinary + 2 OT1
  const e = (await call(w, '/api/timesheets/entries', 'POST', { project_id: pid, work_date: '2026-11-03', start_time: '06:30', end_time: '16:36', break_min: 30 })).body;
  assert.equal(e.hours, 9.6); assert.ok(e.cost > 0);
  const rates = (await call(jb, '/api/rates')).body; const rate = rates.find(r => r.state === 'VIC' && r.trade === worker.trade && r.classification === worker.classification);
  const expected = (7.6 * rate.base_hourly + 2 * rate.base_hourly * rate.ot_1 + rate.daily_allowances) * (1 + rate.oncost_pct);
  assert.ok(Math.abs(e.cost - expected) < 0.05, `cost ${e.cost} vs ${expected}`);
  // cannot clock in to a job not granted
  assert.equal((await call(w, '/api/timesheets/clock-in', 'POST', { project_id: 3 })).status, 404);
  // submit, PM approves, labour cost code updated
  await call(w, '/api/timesheets/submit', 'POST', { week: '2026-11-02' });
  const before = (await call(jb, `/api/projects/${pid}/labour`)).body.totals.approved_cost;
  const r = await call(jb, '/api/timesheets/approve', 'POST', { ids: [e.id] }); assert.equal(r.body.approved, 1);
  const after = (await call(jb, `/api/projects/${pid}/labour`)).body.totals.approved_cost;
  assert.ok(Math.abs(after - before - e.cost) < 0.05);
  const cc = (await call(jb, `/api/projects/${pid}`)).body.cost_codes.find(c => /labour/i.test(c.name)); assert.ok(Math.abs(cc.actual - after) < 0.05, 'labour cost code reflects approved timesheets');
  // field staff cannot approve, raise VOs, see attendance, or record toolbox talks
  assert.equal((await call(w, '/api/timesheets/approve', 'POST', { ids: [e.id] })).status, 403);
  assert.equal((await call(w, `/api/projects/${pid}/variations`, 'POST', { title: 'nope' })).status, 403);
  assert.equal((await call(w, '/api/attendance')).status, 403);
  assert.equal((await call(w, `/api/projects/${pid}/toolbox`, 'POST', { held_on: '2026-11-04', topic: 'nope' })).status, 403);
});

test('attendance: expected vs signed in per job', async () => {
  const jb = await login('jayden.brown@premiersg.com.au'); await enter(jb, 1);
  const a = (await call(jb, '/api/attendance?date=2026-11-03')).body;
  assert.ok(a.totals.expected > 0); assert.equal(a.totals.present + a.totals.away + a.totals.elsewhere, a.projects.reduce((n, p) => n + p.people.length, 0));
  const job = a.projects.find(p => p.expected > 0); assert.ok(job.people.every(x => ['present', 'signed_out', 'away', 'elsewhere'].includes(x.status)));
});

test('WIP: earned = contract × cost %, wip = earned − claimed; discipline split sums to total', async () => {
  const d = await login('director@premiersg.com.au'); await enter(d, null);
  const w = (await call(d, '/api/insights/wip')).body;
  const p = w.branches[0].projects[0];
  assert.ok(Math.abs(p.earned - p.contract_total * p.pct_cost) < 1);
  assert.ok(Math.abs(p.wip - (p.earned - p.claimed)) < 1);
  assert.ok(Math.abs(w.totals.underclaimed - w.totals.unearned - w.totals.wip) < 1);
  const disc = (await call(d, '/api/insights/by-discipline')).body;
  assert.ok(Math.abs(disc.disciplines.reduce((a, x) => a + x.totals.contract, 0) - disc.totals.contract) < 1);
  const pm = (await call(d, '/api/insights/by-pm')).body; assert.ok(pm.pms.length > 10);
  const wade = await login('wade.kneale@premiersg.com.au'); await enter(wade, 1);
  assert.equal((await call(wade, '/api/insights/wip')).status, 403); // PMs don't get the CFO views
});

test('toolbox talks: supervisors record on their jobs; onboarding page is public', async () => {
  const nk = await login('nathan.kurzemnieks@premiersg.com.au'); await enter(nk, 1);
  const t = await call(nk, '/api/projects/1/toolbox', 'POST', { held_on: '2026-11-04', topic: 'Test talk', attendees: [{ id: 1, name: 'x' }], files: [{ name: 'sheet.txt', mime: 'text/plain', data: Buffer.from('signed').toString('base64') }] });
  assert.equal(t.status, 201);
  assert.equal((await call(nk, '/api/projects/5/toolbox', 'POST', { held_on: '2026-11-04', topic: 'nope' })).status, 404); // not his job
  const list = (await call(nk, '/api/toolbox?project_id=1')).body; assert.ok(list.some(x => x.topic === 'Test talk' && x.files.length === 1));
  const jb = await login('jayden.brown@premiersg.com.au'); await enter(jb, 1);
  const o = (await call(jb, '/api/onboarding')).body; assert.ok(o.qr_svg.startsWith('<svg'));
  const pub = await fetch(base + '/onboard/' + o.token); assert.equal(pub.status, 200); assert.ok((await pub.text()).includes('Welcome to Premier Services Group'));
  assert.equal((await fetch(base + '/onboard/nope')).status, 404);
});
