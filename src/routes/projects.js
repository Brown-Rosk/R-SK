'use strict';
const { HttpError } = require('../http');
const A = require('../auth');

// Roll-up figures for one project: contract (incl. approved VOs), claimed, cost, forecast margin, open VOs.
function projectSummary(db, p) {
  const vo = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status='approved' THEN approved_amt END),0) approved,
      COALESCE(SUM(CASE WHEN status IN ('submitted','priced') THEN submitted_amt END),0) open_amt,
      SUM(CASE WHEN status IN ('submitted','priced') THEN 1 ELSE 0 END) open_n,
      SUM(CASE WHEN status='disputed' THEN 1 ELSE 0 END) disputed_n,
      SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) approved_n
    FROM variations WHERE project_id = ?`).get(p.id);
  const cl = db.prepare(`SELECT COALESCE(SUM(l.this_claim),0) claimed, COUNT(DISTINCT CASE WHEN c.status='certified' THEN c.id END) certified_n
    FROM claims c JOIN claim_lines l ON l.claim_id = c.id WHERE c.project_id = ? AND c.status IN ('served','certified')`).get(p.id);
  const cc = db.prepare(`SELECT COALESCE(SUM(budget),0) budget, COALESCE(SUM(committed),0) committed,
    COALESCE(SUM(actual),0) actual, COALESCE(SUM(forecast),0) forecast FROM cost_codes WHERE project_id = ?`).get(p.id);
  const contract_total = p.contract_value + vo.approved;
  const forecast_margin_pct = contract_total ? (contract_total - cc.forecast) / contract_total : null;
  return { contract_total, approved_vo: vo.approved, approved_vo_n: vo.approved_n, open_vo_amt: vo.open_amt, open_vo_n: vo.open_n,
    disputed_vo_n: vo.disputed_n, claimed: cl.claimed, claimed_pct: contract_total ? cl.claimed / contract_total : 0,
    certified_claims: cl.certified_n, cost: cc, forecast_margin_pct, tender_margin_pct: p.tender_margin_pct };
}

module.exports = (r) => {
  // List projects visible to this user in the current branch.
  r.get('/api/projects', A.requireBranch, (ctx) => {
    const s = A.projectScope(ctx);
    const rows = ctx.db.prepare(`SELECT p.*, u.name lead_pm_name,
        ${A.seesWholeBranch(ctx) ? "'lead'" : '(SELECT level FROM project_access WHERE project_id = p.id AND user_id = ?)'} access_level
        FROM projects p LEFT JOIN users u ON u.id = p.lead_pm_id
        WHERE ${s.sql} ORDER BY p.status = 'live' DESC, p.number DESC`).all(...(A.seesWholeBranch(ctx) ? [] : [ctx.user.id]), ...s.params);
    return rows.map(p => ({ ...p, summary: projectSummary(ctx.db, p) }));
  });

  r.post('/api/projects', A.requireRole('branch_manager', 'pm', 'estimator'), (ctx) => {
    const b = ctx.body;
    if (!b.number || !b.name) throw new HttpError(400, 'number and name are required');
    const info = ctx.db.prepare(`INSERT INTO projects (branch_id, number, name, client, head_contractor, lead_pm_id, contract_value,
        retention_pct, retention_cap_pct, claim_day, start_date, pc_date, tender_margin_pct)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ctx.branch.id, b.number, b.name, b.client || null, b.head_contractor || null,
      b.lead_pm_id || ctx.user.id, Number(b.contract_value || 0), b.retention_pct ?? 0.05, b.retention_cap_pct ?? 0.05,
      b.claim_day ?? 5, b.start_date || null, b.pc_date || null, b.tender_margin_pct ?? null);
    const id = Number(info.lastInsertRowid);
    // creator (or named lead PM) gets lead access; branch managers already see everything
    const lead = b.lead_pm_id || ctx.user.id;
    ctx.db.prepare('INSERT OR REPLACE INTO project_access (project_id, user_id, level, granted_by) VALUES (?,?,?,?)').run(id, lead, 'lead', ctx.user.id);
    A.audit(ctx, 'project.create', 'project', id, { number: b.number, name: b.name });
    ctx.status = 201;
    return A.loadProject(ctx, id);
  });

  r.get('/api/projects/:id', A.requireBranch, (ctx) => {
    const p = A.loadProject(ctx, ctx.params.id);
    const db = ctx.db;
    return { ...p, summary: projectSummary(db, p),
      cost_codes: db.prepare('SELECT * FROM cost_codes WHERE project_id = ? ORDER BY code').all(p.id),
      programme: db.prepare('SELECT * FROM programme_stages WHERE project_id = ? ORDER BY sort').all(p.id),
      sov: db.prepare('SELECT * FROM sov_items WHERE project_id = ? ORDER BY sort').all(p.id),
      attention: db.prepare('SELECT * FROM attention_items WHERE project_id = ? AND resolved = 0 ORDER BY severity DESC, created_at').all(p.id),
      team: db.prepare(`SELECT pa.user_id, pa.level, pa.granted_at, u.name, u.initials, g.name granted_by_name FROM project_access pa
                        JOIN users u ON u.id = pa.user_id LEFT JOIN users g ON g.id = pa.granted_by WHERE pa.project_id = ?`).all(p.id) };
  });

  r.patch('/api/projects/:id', A.requireBranch, (ctx) => {
    const p = A.loadProject(ctx, ctx.params.id); A.requireWrite(ctx, p);
    const allowed = ['name', 'client', 'head_contractor', 'contract_value', 'retention_pct', 'retention_cap_pct', 'claim_day', 'start_date', 'pc_date', 'status', 'tender_margin_pct', 'lead_pm_id'];
    const sets = []; const vals = [];
    for (const k of allowed) if (k in ctx.body) { sets.push(`${k} = ?`); vals.push(ctx.body[k]); }
    if (!sets.length) throw new HttpError(400, 'Nothing to update');
    ctx.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, p.id);
    A.audit(ctx, 'project.update', 'project', p.id, ctx.body);
    return A.loadProject(ctx, p.id);
  });

  // Cost codes (budget vs committed vs actual vs forecast). Actuals will come from Sage; editable for now.
  r.put('/api/projects/:id/cost-codes', A.requireBranch, (ctx) => {
    const p = A.loadProject(ctx, ctx.params.id); A.requireWrite(ctx, p);
    const up = ctx.db.prepare(`INSERT INTO cost_codes (project_id, code, name, budget, committed, actual, forecast) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(project_id, code) DO UPDATE SET name=excluded.name, budget=excluded.budget, committed=excluded.committed,
      actual=excluded.actual, forecast=excluded.forecast`);
    for (const c of ctx.body.cost_codes || []) up.run(p.id, c.code, c.name, +c.budget || 0, +c.committed || 0, +c.actual || 0, +c.forecast || 0);
    A.audit(ctx, 'project.cost_codes', 'project', p.id);
    return ctx.db.prepare('SELECT * FROM cost_codes WHERE project_id = ? ORDER BY code').all(p.id);
  });

  r.put('/api/projects/:id/sov', A.requireBranch, (ctx) => {
    const p = A.loadProject(ctx, ctx.params.id); A.requireWrite(ctx, p);
    const items = ctx.body.sov || [];
    const total = items.reduce((s, i) => s + (+i.amount || 0), 0);
    if (Math.abs(total - p.contract_value) > 0.5) throw new HttpError(400, `Schedule of values ($${total}) must equal contract value ($${p.contract_value})`);
    const db = ctx.db;
    db.exec('BEGIN');
    try {
      const del = db.prepare('DELETE FROM sov_items WHERE project_id = ? AND id NOT IN (' + (items.filter(i => i.id).map(() => '?').join(',') || '0') + ')');
      del.run(p.id, ...items.filter(i => i.id).map(i => i.id));
      const ins = db.prepare('INSERT INTO sov_items (project_id, code, description, amount, sort) VALUES (?,?,?,?,?)');
      const upd = db.prepare('UPDATE sov_items SET code=?, description=?, amount=?, sort=? WHERE id=? AND project_id=?');
      items.forEach((i, idx) => i.id ? upd.run(i.code, i.description, +i.amount, idx, i.id, p.id) : ins.run(p.id, i.code, i.description, +i.amount, idx));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    A.audit(ctx, 'project.sov', 'project', p.id);
    return db.prepare('SELECT * FROM sov_items WHERE project_id = ? ORDER BY sort').all(p.id);
  });

  r.put('/api/projects/:id/programme', A.requireBranch, (ctx) => {
    const p = A.loadProject(ctx, ctx.params.id); A.requireWrite(ctx, p);
    ctx.db.prepare('DELETE FROM programme_stages WHERE project_id = ?').run(p.id);
    const ins = ctx.db.prepare('INSERT INTO programme_stages (project_id, name, pct_complete, sort) VALUES (?,?,?,?)');
    (ctx.body.programme || []).forEach((s, i) => ins.run(p.id, s.name, Math.min(100, Math.max(0, +s.pct_complete || 0)), i));
    return ctx.db.prepare('SELECT * FROM programme_stages WHERE project_id = ? ORDER BY sort').all(p.id);
  });

  r.post('/api/projects/:id/attention/:itemId/resolve', A.requireBranch, (ctx) => {
    const p = A.loadProject(ctx, ctx.params.id); A.requireWrite(ctx, p);
    ctx.db.prepare('UPDATE attention_items SET resolved = 1 WHERE id = ? AND project_id = ?').run(ctx.params.itemId, p.id);
    return { ok: true };
  });

  function money0(n) { n = Number(n) || 0; return n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'k' : '$' + Math.round(n); }

// Branch dashboard: everything the user can see, rolled up, plus the attention feed.
  r.get('/api/dashboard', A.requireBranch, (ctx) => {
    const s = A.projectScope(ctx);
    const projects = ctx.db.prepare(`SELECT p.*, u.name lead_pm_name FROM projects p LEFT JOIN users u ON u.id = p.lead_pm_id WHERE ${s.sql} AND p.status = 'live'`).all(...s.params)
      .map(p => ({ ...p, summary: projectSummary(ctx.db, p) }));
    const tot = projects.reduce((t, p) => { const x = p.summary; t.contract += x.contract_total; t.claimed += x.claimed; t.cost += x.cost.actual;
      t.forecast += x.cost.forecast; t.open_vo += x.open_vo_amt; t.open_vo_n += x.open_vo_n; return t; },
      { contract: 0, claimed: 0, cost: 0, forecast: 0, open_vo: 0, open_vo_n: 0 });
    tot.forecast_margin_pct = tot.contract ? (tot.contract - tot.forecast) / tot.contract : null;
    const ids = projects.map(p => p.id);
    const attention = ids.length ? ctx.db.prepare(`SELECT a.*, p.number project_number FROM attention_items a JOIN projects p ON p.id = a.project_id
      WHERE a.resolved = 0 AND a.project_id IN (${ids.map(() => '?').join(',')}) ORDER BY a.severity DESC, a.created_at LIMIT 12`).all(...ids) : [];
    // Generated attention: claims to approve or serve, variations waiting on the client, labour drift, timesheets to approve
    const generated = [];
    if (ids.length) {
      const inList = ids.map(() => '?').join(',');
      ctx.db.prepare(`SELECT c.id, c.number, c.project_id, c.serve_by, c.status, p.number pn FROM claims c JOIN projects p ON p.id = c.project_id
        WHERE c.status IN ('draft','internal_review','approved') AND c.project_id IN (${inList}) AND c.serve_by <= date('now', '+7 days') ORDER BY c.serve_by`).all(...ids)
        .forEach(c => generated.push({ tag: c.serve_by < new Date().toISOString().slice(0, 10) ? 'Late' : 'Due ' + c.serve_by.slice(5), severity: 'high', text: `Claim #${c.number} — ${c.status === 'approved' ? 'approved, not yet served' : c.status === 'internal_review' ? 'awaiting approval' : 'still a draft'} — serve by ${c.serve_by}`, link: `#/projects/${c.project_id}/claims/${c.id}`, project_number: c.pn }));
      if (['branch_manager', 'finance'].includes(ctx.role) || ctx.user.is_group_admin) ctx.db.prepare(`SELECT c.id, c.number, c.project_id, (SELECT COALESCE(SUM(this_claim),0) FROM claim_lines l WHERE l.claim_id = c.id) amt, p.number pn FROM claims c JOIN projects p ON p.id = c.project_id WHERE c.status = 'internal_review' AND c.project_id IN (${inList}) AND c.serve_by > date('now', '+7 days') ORDER BY c.serve_by`).all(...ids)
        .forEach(c => generated.push({ tag: 'Approve', severity: 'warn', text: `Claim #${c.number} (${money0(c.amt)}) is waiting for your approval`, link: `#/projects/${c.project_id}/claims/${c.id}`, project_number: c.pn }));
      const vos = ctx.db.prepare(`SELECT v.id, v.number, v.title, v.project_id, v.submitted_amt amount, p.number pn, julianday('now') - julianday(v.submitted_at) days FROM variations v JOIN projects p ON p.id = v.project_id
        WHERE v.status = 'submitted' AND v.project_id IN (${inList}) AND julianday('now') - julianday(v.submitted_at) > ? ORDER BY days DESC`).all(...ids, ctx.branch.vo_response_days);
      vos.slice(0, 4).forEach(v => generated.push({ tag: `${Math.floor(v.days)} days`, severity: v.days > 2 * ctx.branch.vo_response_days ? 'high' : 'warn', text: `VO-${String(v.number).padStart(3, '0')} ${v.title} (${money0(v.amount)}) — no client response in ${Math.floor(v.days)} days`, link: `#/projects/${v.project_id}/variations`, project_number: v.pn }));
      if (vos.length > 4) { const rest = vos.slice(4); generated.push({ tag: `${rest.length} more`, severity: 'warn', text: `${rest.length} other variations past the ${ctx.branch.vo_response_days}-day response period (${money0(rest.reduce((a, v) => a + (v.amount || 0), 0))})`, link: '#/variations', project_number: '' }); }
      projects.filter(p => p.summary.tender_margin_pct != null && p.summary.forecast_margin_pct != null && p.summary.forecast_margin_pct < p.summary.tender_margin_pct - 0.02)
        .forEach(p => generated.push({ tag: 'Margin', severity: 'high', text: `Forecast margin ${(p.summary.forecast_margin_pct * 100).toFixed(1)}% against ${(p.summary.tender_margin_pct * 100).toFixed(1)}% at tender`, link: `#/projects/${p.id}`, project_number: p.number }));
      if (['supervisor', 'pm', 'branch_manager'].includes(ctx.role)) { const ts = ctx.db.prepare(`SELECT COUNT(*) n, COUNT(DISTINCT user_id) people FROM timesheet_entries WHERE status = 'submitted' AND project_id IN (${inList})`).get(...ids); if (ts.n) generated.push({ tag: 'Timesheets', severity: 'info', text: `${ts.n} timesheet entries from ${ts.people} people waiting for approval`, link: '#/approvals', project_number: '' }); }
    }
    return { totals: tot, projects, attention: [...generated, ...attention] };
  });
};

module.exports.projectSummary = projectSummary;
