'use strict';
const { HttpError } = require('../http');
const A = require('../auth');

// Workflow: draft -> internal_review -> approved -> served -> certified   (approved/review -> draft to reopen)
const TRANSITIONS = { draft: ['internal_review'], internal_review: ['approved', 'draft'], approved: ['served', 'draft'], served: ['certified'], certified: [] };

function addDays(iso, n) { const d = new Date(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function addBusinessDays(iso, n) { const d = new Date(iso); let c = 0; while (c < n) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) c++; } return d.toISOString().slice(0, 10); }
function r2(x) { return Math.round(x * 100) / 100; }

// Previously claimed per line = sum of this_claim across earlier SERVED/CERTIFIED claims on this project.
function prevClaimedMap(db, projectId, beforeClaimNumber) {
  const rows = db.prepare(`SELECT l.kind, l.ref_id, SUM(l.this_claim) amt FROM claim_lines l JOIN claims c ON c.id = l.claim_id
    WHERE c.project_id = ? AND c.number < ? AND c.status IN ('served','certified') GROUP BY l.kind, l.ref_id`).all(projectId, beforeClaimNumber);
  const m = new Map(); rows.forEach(x => m.set(x.kind + ':' + x.ref_id, x.amt)); return m;
}

function buildLines(db, p, claim) {
  const prev = prevClaimedMap(db, p.id, claim.number);
  const existing = new Map(db.prepare('SELECT * FROM claim_lines WHERE claim_id = ?').all(claim.id).map(l => [l.kind + ':' + l.ref_id, l]));
  const lines = [];
  db.prepare('SELECT * FROM sov_items WHERE project_id = ? ORDER BY sort').all(p.id).forEach((s, i) => {
    const k = 'base:' + s.id; const e = existing.get(k);
    lines.push({ kind: 'base', ref_id: s.id, description: `${s.code} ${s.description}`, contract_amt: s.amount, prev_claimed: prev.get(k) || 0, this_claim: e ? e.this_claim : 0, sort: i });
  });
  db.prepare("SELECT * FROM variations WHERE project_id = ? AND status = 'approved' ORDER BY number").all(p.id).forEach((v, i) => {
    const k = 'variation:' + v.id; const e = existing.get(k);
    lines.push({ kind: 'variation', ref_id: v.id, description: `VO-${String(v.number).padStart(3, '0')} ${v.title}`, contract_amt: v.approved_amt, prev_claimed: prev.get(k) || 0, this_claim: e ? e.this_claim : 0, sort: 1000 + i });
  });
  // persist (keeps lines in step with SOV and newly approved VOs while draft)
  if (claim.status === 'draft' || claim.status === 'internal_review') {
    const up = db.prepare(`INSERT INTO claim_lines (claim_id, kind, ref_id, description, contract_amt, prev_claimed, this_claim, sort) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(claim_id, kind, ref_id) DO UPDATE SET description=excluded.description, contract_amt=excluded.contract_amt, prev_claimed=excluded.prev_claimed, sort=excluded.sort`);
    lines.forEach(l => up.run(claim.id, l.kind, l.ref_id, l.description, l.contract_amt, l.prev_claimed, l.this_claim, l.sort));
    return db.prepare('SELECT * FROM claim_lines WHERE claim_id = ? ORDER BY sort').all(claim.id);
  }
  return db.prepare('SELECT * FROM claim_lines WHERE claim_id = ? ORDER BY sort').all(claim.id);
}

function summarise(db, p, claim, lines, branch) {
  const base = lines.filter(l => l.kind === 'base'); const vos = lines.filter(l => l.kind === 'variation');
  const sum = (arr, f) => arr.reduce((t, l) => t + (f(l) || 0), 0);
  const this_period = sum(lines, l => l.this_claim);
  const cumulative = sum(lines, l => l.prev_claimed + l.this_claim);
  const contract_total = sum(lines, l => l.contract_amt);
  const retention_cap = p.retention_cap_pct * contract_total;
  const retention_held_cum = Math.min(retention_cap, p.retention_pct * cumulative);
  const prev_cum = sum(lines, l => l.prev_claimed);
  const retention_held_prev = Math.min(retention_cap, p.retention_pct * prev_cum);
  const retention_this = retention_held_cum - retention_held_prev;
  const prev_certified = db.prepare(`SELECT COALESCE(SUM(certified_amt),0) a FROM claims WHERE project_id = ? AND number < ? AND status = 'certified'`).get(p.id, claim.number).a;
  // amount claimed = cumulative less retention held less previously certified (ex GST)
  const amount_ex_gst = cumulative - retention_held_cum - prev_certified;
  const gst = amount_ex_gst * branch.gst_rate;
  return { contract_total, base_total: sum(base, l => l.contract_amt), vo_total: sum(vos, l => l.contract_amt),
    base_this: sum(base, l => l.this_claim), vo_this: sum(vos, l => l.this_claim), this_period: r2(this_period), cumulative: r2(cumulative),
    pct_complete: contract_total ? cumulative / contract_total : 0, retention_this: r2(retention_this), retention_held: r2(retention_held_cum),
    prev_certified: r2(prev_certified), amount_ex_gst: r2(amount_ex_gst), gst: r2(gst), amount_inc_gst: r2(amount_ex_gst + gst) };
}

// Pre-serve checks. Each: { level: ok|check|fail, text }
function checks(db, p, claim, lines, branch) {
  const out = [];
  const today = new Date().toISOString().slice(0, 10);
  out.push(claim.serve_by >= today ? { level: 'ok', text: `Within the reference-date window (serve by ${claim.serve_by})` }
                                   : { level: 'check', text: `Serve-by date ${claim.serve_by} has passed — serve as soon as possible and check the contract for late-claim consequences` });
  const over = lines.filter(l => l.prev_claimed + l.this_claim > l.contract_amt + 0.005);
  out.push(over.length ? { level: 'fail', text: `${over.length} line(s) claim more than their contract value: ${over.map(l => l.description).join('; ')}` } : { level: 'ok', text: 'No line exceeds its contract value' });
  const neg = lines.filter(l => l.this_claim < 0);
  if (neg.length) out.push({ level: 'check', text: `${neg.length} negative line(s) — confirm these are agreed credits` });
  // VOs on the claim must be approved (buildLines only includes approved, but a VO could be re-opened)
  const voIds = lines.filter(l => l.kind === 'variation' && l.this_claim > 0).map(l => l.ref_id);
  if (voIds.length) {
    const bad = db.prepare(`SELECT number FROM variations WHERE id IN (${voIds.map(() => '?').join(',')}) AND status != 'approved'`).all(...voIds);
    out.push(bad.length ? { level: 'fail', text: `Unapproved VO(s) on the claim: ${bad.map(b => 'VO-' + String(b.number).padStart(3, '0')).join(', ')}` } : { level: 'ok', text: 'All claimed VOs are approved in the register' });
  } else out.push({ level: 'ok', text: 'No variations claimed this period' });
  // Programme sanity: a base line claimed well ahead of the matching programme stage
  const stages = db.prepare('SELECT name, pct_complete FROM programme_stages WHERE project_id = ?').all(p.id);
  lines.filter(l => l.kind === 'base' && l.contract_amt > 0).forEach(l => {
    const pct = (l.prev_claimed + l.this_claim) / l.contract_amt * 100;
    const st = stages.find(s => l.description.toLowerCase().includes(s.name.toLowerCase().split(' ')[0]) || s.name.toLowerCase().includes(l.description.split(' ').slice(1, 3).join(' ').toLowerCase()));
    if (st && pct > st.pct_complete + 10) out.push({ level: 'check', text: `${l.description} claimed ${Math.round(pct)}% but programme shows ${Math.round(st.pct_complete)}% — confirm with site` });
  });
  // Cost sanity: claimed % well ahead of cost %
  const cc = db.prepare('SELECT COALESCE(SUM(actual),0) a, COALESCE(SUM(forecast),0) f FROM cost_codes WHERE project_id = ?').get(p.id);
  const s = summarise(db, p, claim, lines, branch);
  if (cc.f > 0 && s.pct_complete > cc.a / cc.f + 0.15) out.push({ level: 'check', text: `Claimed ${Math.round(s.pct_complete * 100)}% complete but cost is ${Math.round(cc.a / cc.f * 100)}% of forecast — front-loaded or cost lagging in Sage?` });
  if (claim.status !== 'certified' && s.amount_ex_gst <= 0) out.push({ level: 'fail', text: 'Claim amount is zero or negative' });
  out.push({ level: 'ok', text: 'Statutory declaration template will be attached on serve' });
  return out;
}

function loadClaim(ctx, id) {
  const c = ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(Number(id));
  if (!c) throw new HttpError(404, 'Claim not found');
  const p = A.loadProject(ctx, c.project_id);
  return { c, p };
}

function full(ctx, c, p) {
  const lines = buildLines(ctx.db, p, c);
  const summary = summarise(ctx.db, p, c, lines, ctx.branch);
  const chk = checks(ctx.db, p, c, lines, ctx.branch);
  const history = ctx.db.prepare(`SELECT a.at, a.action, a.detail, u.name user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity='claim' AND a.entity_id = ? ORDER BY a.at`).all(c.id);
  const names = ctx.db.prepare('SELECT id, name FROM users WHERE id IN (?, ?)').all(c.drafted_by || 0, c.approved_by || 0);
  return { ...c, project: { id: p.id, number: p.number, name: p.name, client: p.client, head_contractor: p.head_contractor, retention_pct: p.retention_pct, retention_cap_pct: p.retention_cap_pct },
    lines, summary, checks: chk, history, allowed_transitions: TRANSITIONS[c.status],
    drafted_by_name: names.find(n => n.id === c.drafted_by)?.name, approved_by_name: names.find(n => n.id === c.approved_by)?.name };
}

module.exports = (r) => {
  r.get('/api/claims', A.requireBranch, (ctx) => {
    const s = A.projectScope(ctx);
    const where = [s.sql]; const params = [...s.params];
    if (ctx.query.project_id) { where.push('p.id = ?'); params.push(Number(ctx.query.project_id)); }
    const rows = ctx.db.prepare(`SELECT c.*, p.number project_number, p.name project_name,
        (SELECT COALESCE(SUM(this_claim),0) FROM claim_lines WHERE claim_id = c.id) this_period
      FROM claims c JOIN projects p ON p.id = c.project_id WHERE ${where.join(' AND ')} ORDER BY c.period_end DESC, c.number DESC`).all(...params);
    return rows;
  });

  r.post('/api/projects/:id/claims', A.requireBranch, (ctx) => {
    const p = A.loadProject(ctx, ctx.params.id); A.requireWrite(ctx, p);
    if (ctx.role === 'supervisor') throw new HttpError(403, 'Supervisors cannot draft claims');
    const open = ctx.db.prepare("SELECT number FROM claims WHERE project_id = ? AND status NOT IN ('certified')").get(p.id);
    if (open) throw new HttpError(409, `Claim #${open.number} is still open — certify it before starting the next`);
    const period_end = ctx.body.period_end || new Date().toISOString().slice(0, 8) + '01';
    const next = ctx.db.prepare('SELECT COALESCE(MAX(number),0)+1 n FROM claims WHERE project_id = ?').get(p.id).n;
    // serve-by = claim_day of the following month (contract-specific; default from project)
    const pe = new Date(period_end); const sb = new Date(Date.UTC(pe.getUTCFullYear(), pe.getUTCMonth() + 1, p.claim_day));
    const serve_by = ctx.body.serve_by || sb.toISOString().slice(0, 10);
    const info = ctx.db.prepare('INSERT INTO claims (project_id, number, period_end, serve_by, drafted_by) VALUES (?,?,?,?,?)').run(p.id, next, period_end, serve_by, ctx.user.id);
    const id = Number(info.lastInsertRowid);
    A.audit(ctx, 'claim.create', 'claim', id, { project: p.number, number: next, period_end });
    ctx.status = 201;
    return full(ctx, ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(id), p);
  });

  r.get('/api/claims/:id', A.requireBranch, (ctx) => { const { c, p } = loadClaim(ctx, ctx.params.id); return full(ctx, c, p); });

  // Update lines: body { lines: [{kind, ref_id, this_claim}] } or { lines: [{kind, ref_id, pct}] } (pct = cumulative % complete)
  r.put('/api/claims/:id/lines', A.requireBranch, (ctx) => {
    const { c, p } = loadClaim(ctx, ctx.params.id); A.requireWrite(ctx, p);
    if (!['draft', 'internal_review'].includes(c.status)) throw new HttpError(409, 'Claim is locked — reopen to draft to edit');
    const lines = buildLines(ctx.db, p, c);
    const upd = ctx.db.prepare('UPDATE claim_lines SET this_claim = ? WHERE claim_id = ? AND kind = ? AND ref_id = ?');
    for (const l of ctx.body.lines || []) {
      const cur = lines.find(x => x.kind === l.kind && x.ref_id === Number(l.ref_id));
      if (!cur) continue;
      let amt;
      if (l.pct != null) amt = (Math.min(100, Math.max(0, +l.pct)) / 100) * cur.contract_amt - cur.prev_claimed;
      else amt = +l.this_claim || 0;
      upd.run(r2(amt), c.id, l.kind, Number(l.ref_id));
    }
    A.audit(ctx, 'claim.lines', 'claim', c.id);
    return full(ctx, c, p);
  });

  r.patch('/api/claims/:id', A.requireBranch, (ctx) => {
    const { c, p } = loadClaim(ctx, ctx.params.id); A.requireWrite(ctx, p);
    const sets = []; const vals = [];
    for (const k of ['period_end', 'serve_by', 'notes']) if (k in ctx.body) { sets.push(`${k} = ?`); vals.push(ctx.body[k]); }
    if (sets.length) ctx.db.prepare(`UPDATE claims SET ${sets.join(', ')} WHERE id = ?`).run(...vals, c.id);
    return full(ctx, ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(c.id), p);
  });

  // Workflow. Body: { to, certified_amt?, date?, note? }
  r.post('/api/claims/:id/transition', A.requireBranch, (ctx) => {
    const { c, p } = loadClaim(ctx, ctx.params.id);
    const to = ctx.body.to;
    if (!(to === 'certified' && ctx.role === 'finance')) A.requireWrite(ctx, p); // finance's one write: recording the payment schedule
    if (!TRANSITIONS[c.status].includes(to)) throw new HttpError(409, `Cannot move claim from ${c.status} to ${to}`);
    const role = ctx.role; const sets = { status: to };
    const today = ctx.body.date || new Date().toISOString().slice(0, 10);
    if (to === 'internal_review') {
      const f = full(ctx, c, p);
      const fails = f.checks.filter(x => x.level === 'fail');
      if (fails.length) throw new HttpError(409, 'Fix failing checks before submitting for review', { checks: fails });
    }
    if (to === 'approved') {
      if (!['branch_manager', 'group_admin'].includes(role)) throw new HttpError(403, 'Branch Manager approval required');
      sets.approved_by = ctx.user.id;
    }
    if (to === 'served') {
      if (!['branch_manager', 'pm', 'group_admin'].includes(role)) throw new HttpError(403, 'Only the PM or Branch Manager can serve a claim');
      sets.served_at = today; sets.payment_due = addBusinessDays(today, ctx.branch.claim_response_days + 5);
    }
    if (to === 'certified') {
      if (!['branch_manager', 'finance', 'group_admin'].includes(role)) throw new HttpError(403, 'Finance or Branch Manager records certification');
      if (ctx.body.certified_amt == null) throw new HttpError(400, 'certified_amt required');
      sets.certified_amt = +ctx.body.certified_amt; sets.certified_at = today;
    }
    if (ctx.body.note) sets.notes = ((c.notes || '') + `\n[${today} ${ctx.user.name}] ${ctx.body.note}`).trim();
    const keys = Object.keys(sets);
    ctx.db.prepare(`UPDATE claims SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => sets[k]), c.id);
    A.audit(ctx, `claim.${to}`, 'claim', c.id, { from: c.status, certified_amt: sets.certified_amt, note: ctx.body.note });
    // Shortfall on certification -> attention item (dispute to raise)
    if (to === 'certified') {
      const f = full(ctx, { ...c, ...sets }, p);
      const short = f.summary.amount_ex_gst - sets.certified_amt;
      if (short > 0.5) ctx.db.prepare('INSERT INTO attention_items (project_id, tag, text, link, severity) VALUES (?,?,?,?,?)')
        .run(p.id, 'Shortfall', `Claim #${c.number} certified $${short.toLocaleString()} short of claimed — review payment schedule reasons and raise dispute if warranted`, `#/projects/${p.id}/claims/${c.id}`, 'high');
    }
    return full(ctx, ctx.db.prepare('SELECT * FROM claims WHERE id = ?').get(c.id), p);
  });

  r.delete('/api/claims/:id', A.requireBranch, (ctx) => {
    const { c, p } = loadClaim(ctx, ctx.params.id); A.requireWrite(ctx, p);
    if (c.status !== 'draft') throw new HttpError(409, 'Only draft claims can be deleted');
    ctx.db.prepare('DELETE FROM claims WHERE id = ?').run(c.id);
    A.audit(ctx, 'claim.delete', 'claim', c.id, { number: c.number });
    return { ok: true };
  });
};

module.exports.TRANSITIONS = TRANSITIONS;
