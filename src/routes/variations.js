'use strict';
const { HttpError } = require('../http');
const A = require('../auth');

// Workflow: draft -> priced -> submitted -> approved | disputed | rejected ; disputed -> approved | rejected | submitted
const TRANSITIONS = {
  draft: ['priced'], priced: ['submitted', 'draft'], submitted: ['approved', 'disputed', 'rejected'],
  disputed: ['approved', 'rejected', 'submitted'], approved: [], rejected: ['draft'],
};
const SOURCES = ['Client instruction', 'RFI response', 'Latent condition', 'Design change', 'Delay / disruption', 'Other'];
const DISCIPLINES = ['Wet fire', 'Dry fire', 'Design', 'Mechanical', 'Electrical'];

function fmtNo(n) { return 'VO-' + String(n).padStart(3, '0'); }

function withDerived(v) {
  const ref = v.submitted_at || v.raised_at;
  const days = v.status === 'submitted' || v.status === 'disputed' ? Math.floor((Date.now() - new Date(ref).getTime()) / 86400000) : null;
  return { ...v, label: fmtNo(v.number), days_out: days,
    priced_total: (v.labour_amt || 0) + (v.materials_amt || 0) + (v.sub_plant_amt || 0) + (v.prelims_margin_amt || 0) };
}

module.exports = (r) => {
  r.get('/api/meta/variations', (ctx) => ({ sources: SOURCES, disciplines: ctx.company ? require('../company').settings(ctx.company).disciplines : DISCIPLINES, transitions: TRANSITIONS }));

  // Register across all visible projects (branch register) or one project (?project_id=)
  r.get('/api/variations', A.requireBranch, (ctx) => {
    const s = A.projectScope(ctx);
    const where = [s.sql]; const params = [...s.params];
    if (ctx.query.project_id) { where.push('p.id = ?'); params.push(Number(ctx.query.project_id)); }
    if (ctx.query.status) { where.push('v.status = ?'); params.push(ctx.query.status); }
    if (ctx.query.unclaimed === '1') where.push('v.id NOT IN (SELECT ref_id FROM claim_lines WHERE kind = \'variation\')');
    const rows = ctx.db.prepare(`SELECT v.*, p.number project_number, p.name project_name, u.initials owner_initials, u.name owner_name,
        (SELECT c.number FROM claim_lines l JOIN claims c ON c.id = l.claim_id WHERE l.kind='variation' AND l.ref_id = v.id AND l.this_claim > 0 ORDER BY c.number LIMIT 1) first_claim_no
      FROM variations v JOIN projects p ON p.id = v.project_id LEFT JOIN users u ON u.id = v.owner_id
      WHERE ${where.join(' AND ')} ORDER BY v.project_id, v.number DESC`).all(...params);
    const list = rows.map(withDerived);
    const sum = (f) => list.filter(f).reduce((t, v) => t + (v.status === 'approved' ? v.approved_amt : v.submitted_amt || v.priced_total), 0);
    const totals = {
      approved: sum(v => v.status === 'approved'), approved_n: list.filter(v => v.status === 'approved').length,
      submitted: sum(v => v.status === 'submitted'), submitted_n: list.filter(v => v.status === 'submitted').length,
      disputed: sum(v => ['disputed', 'rejected'].includes(v.status)), disputed_n: list.filter(v => v.status === 'disputed').length,
      rejected_n: list.filter(v => v.status === 'rejected').length,
      unpriced: list.filter(v => v.status === 'draft').reduce((t, v) => t + (v.cost_to_date || 0), 0), unpriced_n: list.filter(v => v.status === 'draft').length,
      avg_days_out: (() => { const d = list.filter(v => v.days_out != null).map(v => v.days_out); return d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : 0; })(),
    };
    return { variations: list, totals };
  });

  r.post('/api/projects/:id/variations', A.requireBranch, (ctx) => {
    const p = A.loadProject(ctx, ctx.params.id); A.requireWrite(ctx, p);
    const b = ctx.body;
    if (!b.title) throw new HttpError(400, 'title is required');
    const next = ctx.db.prepare('SELECT COALESCE(MAX(number),0)+1 n FROM variations WHERE project_id = ?').get(p.id).n;
    const info = ctx.db.prepare(`INSERT INTO variations (project_id, number, title, source, discipline, owner_id, client_ref, notes, labour_hours, labour_amt,
        materials_amt, sub_plant_amt, prelims_margin_amt, cost_to_date, raised_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?, date('now')))`)
      .run(p.id, next, b.title, b.source || null, b.discipline || null, b.owner_id || ctx.user.id, b.client_ref || null, b.notes || null,
        +b.labour_hours || 0, +b.labour_amt || 0, +b.materials_amt || 0, +b.sub_plant_amt || 0, +b.prelims_margin_amt || 0, +b.cost_to_date || 0, b.raised_at || null);
    const id = Number(info.lastInsertRowid);
    A.audit(ctx, 'variation.create', 'variation', id, { project: p.number, number: next, title: b.title });
    ctx.status = 201;
    return withDerived(ctx.db.prepare('SELECT * FROM variations WHERE id = ?').get(id));
  });

  function loadVariation(ctx, id) {
    const v = ctx.db.prepare('SELECT * FROM variations WHERE id = ?').get(Number(id));
    if (!v) throw new HttpError(404, 'Variation not found');
    const p = A.loadProject(ctx, v.project_id); // enforces visibility; 404 if not allowed
    return { v, p };
  }

  r.get('/api/variations/:id', A.requireBranch, (ctx) => {
    const { v, p } = loadVariation(ctx, ctx.params.id);
    const claims = ctx.db.prepare(`SELECT c.id, c.number, c.status, l.this_claim FROM claim_lines l JOIN claims c ON c.id = l.claim_id WHERE l.kind='variation' AND l.ref_id = ?`).all(v.id);
    const history = ctx.db.prepare(`SELECT a.at, a.action, a.detail, u.name user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity='variation' AND a.entity_id = ? ORDER BY a.at`).all(v.id);
    return { ...withDerived(v), project: { id: p.id, number: p.number, name: p.name }, claims, history, allowed_transitions: TRANSITIONS[v.status] };
  });

  r.patch('/api/variations/:id', A.requireBranch, (ctx) => {
    const { v, p } = loadVariation(ctx, ctx.params.id); A.requireWrite(ctx, p);
    if (['approved', 'rejected'].includes(v.status) && !('cost_to_date' in ctx.body && Object.keys(ctx.body).length === 1 || 'pct_done' in ctx.body))
      throw new HttpError(409, `A ${v.status} variation can only have its cost to date updated`);
    const allowed = ['title', 'source', 'discipline', 'owner_id', 'client_ref', 'notes', 'labour_hours', 'labour_amt', 'materials_amt', 'sub_plant_amt', 'prelims_margin_amt', 'cost_to_date', 'pct_done', 'raised_at'];
    const sets = []; const vals = [];
    for (const k of allowed) if (k in ctx.body) { sets.push(`${k} = ?`); vals.push(ctx.body[k]); }
    if (!sets.length) throw new HttpError(400, 'Nothing to update');
    ctx.db.prepare(`UPDATE variations SET ${sets.join(', ')} WHERE id = ?`).run(...vals, v.id);
    A.audit(ctx, 'variation.update', 'variation', v.id, ctx.body);
    return withDerived(ctx.db.prepare('SELECT * FROM variations WHERE id = ?').get(v.id));
  });

  // Move through the workflow. Body: { to, amount?, note? }
  r.post('/api/variations/:id/transition', A.requireBranch, (ctx) => {
    const { v, p } = loadVariation(ctx, ctx.params.id); A.requireWrite(ctx, p);
    const to = ctx.body.to;
    if (!TRANSITIONS[v.status].includes(to)) throw new HttpError(409, `Cannot move ${fmtNo(v.number)} from ${v.status} to ${to}`);
    const role = ctx.role;
    const priced = (v.labour_amt || 0) + (v.materials_amt || 0) + (v.sub_plant_amt || 0) + (v.prelims_margin_amt || 0);
    const sets = { status: to };

    if (to === 'priced') {
      if (priced <= 0) throw new HttpError(400, 'Price the variation before marking it priced');
      sets.submitted_amt = priced;
    }
    if (to === 'submitted') {
      // supervisors can raise and price, but not submit to the client
      if (role === 'supervisor') throw new HttpError(403, 'Supervisors cannot submit variations to the client');
      const amt = ctx.body.amount != null ? +ctx.body.amount : (v.submitted_amt || priced);
      if (amt > ctx.branch.vo_approval_threshold && !['branch_manager', 'group_admin'].includes(role))
        throw new HttpError(403, `Variations over $${ctx.branch.vo_approval_threshold.toLocaleString()} need Branch Manager submission`, { needs_role: 'branch_manager' });
      sets.submitted_amt = amt; sets.submitted_at = ctx.body.date || new Date().toISOString().slice(0, 10);
    }
    if (to === 'approved') {
      const amt = ctx.body.amount != null ? +ctx.body.amount : v.submitted_amt;
      if (!(amt >= 0)) throw new HttpError(400, 'Approved amount required');
      sets.approved_amt = amt; sets.approved_at = ctx.body.date || new Date().toISOString().slice(0, 10); sets.decided_at = sets.approved_at;
    }
    if (to === 'rejected') { sets.approved_amt = 0; sets.decided_at = ctx.body.date || new Date().toISOString().slice(0, 10); }
    if (to === 'draft') { sets.submitted_amt = 0; sets.submitted_at = null; }
    if (ctx.body.note) sets.notes = ((v.notes || '') + `\n[${new Date().toISOString().slice(0, 10)} ${ctx.user.name}] ${ctx.body.note}`).trim();

    const keys = Object.keys(sets);
    ctx.db.prepare(`UPDATE variations SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => sets[k]), v.id);
    A.audit(ctx, `variation.${to}`, 'variation', v.id, { from: v.status, amount: sets.submitted_amt ?? sets.approved_amt, note: ctx.body.note });
    return withDerived(ctx.db.prepare('SELECT * FROM variations WHERE id = ?').get(v.id));
  });

  r.delete('/api/variations/:id', A.requireBranch, (ctx) => {
    const { v, p } = loadVariation(ctx, ctx.params.id); A.requireWrite(ctx, p);
    if (v.status !== 'draft') throw new HttpError(409, 'Only draft variations can be deleted');
    ctx.db.prepare('DELETE FROM variations WHERE id = ?').run(v.id);
    A.audit(ctx, 'variation.delete', 'variation', v.id, { number: v.number });
    return { ok: true };
  });
};
