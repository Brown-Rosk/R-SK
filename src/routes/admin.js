'use strict';
const { HttpError } = require('../http');
const A = require('../auth');
const { projectSummary } = require('./projects');

const MANAGE = A.requireRole('branch_manager');

module.exports = (r) => {
  // ---- users in this branch ----
  r.get('/api/branch/users', A.requireBranch, (ctx) => {
    // PMs can see the people list (to assign owners) but not emails of others' sign-in state; keep it simple: all members visible to branch members
    const rows = ctx.db.prepare(`SELECT u.id, u.name, u.email, u.initials, u.active, u.is_group_admin, bm.role,
        (SELECT COUNT(*) FROM project_access pa JOIN projects p ON p.id = pa.project_id WHERE pa.user_id = u.id AND p.branch_id = ?) job_count
      FROM branch_members bm JOIN users u ON u.id = bm.user_id WHERE bm.branch_id = ? ORDER BY
        CASE bm.role WHEN 'branch_manager' THEN 0 WHEN 'pm' THEN 1 WHEN 'estimator' THEN 2 WHEN 'supervisor' THEN 3 ELSE 4 END, u.name`).all(ctx.branch.id, ctx.branch.id);
    const total = ctx.db.prepare('SELECT COUNT(*) n FROM projects WHERE branch_id = ?').get(ctx.branch.id).n;
    return rows.map(u => ({ ...u, sees_all: A.seesWholeBranch({ role: u.role }) || !!u.is_group_admin, total_jobs: total }));
  });

  // Invite / add a user to this branch. Creates the user if new. Body: { email, name, role, password? }
  r.post('/api/branch/users', MANAGE, (ctx) => {
    const { email, name, role, password } = ctx.body;
    if (!email || !name || !A.ROLES.includes(role)) throw new HttpError(400, `email, name and a role (${A.ROLES.join(', ')}) are required`);
    let u = ctx.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const initials = name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    if (!u) {
      const pw = password || require('node:crypto').randomBytes(6).toString('base64url');
      const info = ctx.db.prepare('INSERT INTO users (email, name, initials, password_hash) VALUES (?,?,?,?)').run(email, name, initials, A.hashPassword(pw));
      u = { id: Number(info.lastInsertRowid), temp_password: password ? undefined : pw };
    }
    ctx.db.prepare('INSERT INTO branch_members (user_id, branch_id, role) VALUES (?,?,?) ON CONFLICT(user_id, branch_id) DO UPDATE SET role = excluded.role').run(u.id, ctx.branch.id, role);
    A.audit(ctx, 'user.add_to_branch', 'user', u.id, { email, role });
    ctx.status = 201;
    return { id: u.id, email, name, role, temp_password: u.temp_password };
  });

  r.patch('/api/branch/users/:id', MANAGE, (ctx) => {
    const uid = Number(ctx.params.id);
    if ('role' in ctx.body) {
      if (!A.ROLES.includes(ctx.body.role)) throw new HttpError(400, 'Invalid role');
      if (uid === ctx.user.id && ctx.body.role !== 'branch_manager') throw new HttpError(409, 'You cannot demote yourself');
      ctx.db.prepare('UPDATE branch_members SET role = ? WHERE user_id = ? AND branch_id = ?').run(ctx.body.role, uid, ctx.branch.id);
    }
    if ('active' in ctx.body) ctx.db.prepare('UPDATE users SET active = ? WHERE id = ?').run(ctx.body.active ? 1 : 0, uid);
    if (ctx.body.password) ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(A.hashPassword(ctx.body.password), uid);
    A.audit(ctx, 'user.update', 'user', uid, { role: ctx.body.role, active: ctx.body.active, password_reset: !!ctx.body.password });
    return { ok: true };
  });

  r.delete('/api/branch/users/:id', MANAGE, (ctx) => {
    const uid = Number(ctx.params.id);
    if (uid === ctx.user.id) throw new HttpError(409, 'You cannot remove yourself');
    ctx.db.prepare('DELETE FROM branch_members WHERE user_id = ? AND branch_id = ?').run(uid, ctx.branch.id);
    ctx.db.prepare('DELETE FROM project_access WHERE user_id = ? AND project_id IN (SELECT id FROM projects WHERE branch_id = ?)').run(uid, ctx.branch.id);
    A.audit(ctx, 'user.remove_from_branch', 'user', uid);
    return { ok: true };
  });

  // ---- per-job access ----
  r.get('/api/branch/users/:id/access', MANAGE, (ctx) => {
    const uid = Number(ctx.params.id);
    return ctx.db.prepare(`SELECT pa.project_id, pa.level, pa.granted_at, p.number, p.name, p.status, g.name granted_by_name
      FROM project_access pa JOIN projects p ON p.id = pa.project_id LEFT JOIN users g ON g.id = pa.granted_by
      WHERE pa.user_id = ? AND p.branch_id = ? ORDER BY p.number DESC`).all(uid, ctx.branch.id);
  });

  r.post('/api/projects/:id/access', MANAGE, (ctx) => {
    const p = A.loadProject(ctx, ctx.params.id);
    const { user_id, level } = ctx.body;
    if (!['lead', 'member', 'readonly'].includes(level)) throw new HttpError(400, 'level must be lead, member or readonly');
    const member = ctx.db.prepare('SELECT 1 FROM branch_members WHERE user_id = ? AND branch_id = ?').get(user_id, ctx.branch.id);
    if (!member) throw new HttpError(400, 'User is not a member of this branch — add them first');
    ctx.db.prepare('INSERT INTO project_access (project_id, user_id, level, granted_by) VALUES (?,?,?,?) ON CONFLICT(project_id, user_id) DO UPDATE SET level = excluded.level, granted_by = excluded.granted_by, granted_at = datetime(\'now\')')
      .run(p.id, user_id, level, ctx.user.id);
    if (level === 'lead') ctx.db.prepare('UPDATE projects SET lead_pm_id = ? WHERE id = ?').run(user_id, p.id);
    A.audit(ctx, 'access.grant', 'project', p.id, { user_id, level });
    return { ok: true };
  });

  r.delete('/api/projects/:id/access/:userId', MANAGE, (ctx) => {
    const p = A.loadProject(ctx, ctx.params.id);
    ctx.db.prepare('DELETE FROM project_access WHERE project_id = ? AND user_id = ?').run(p.id, Number(ctx.params.userId));
    A.audit(ctx, 'access.revoke', 'project', p.id, { user_id: Number(ctx.params.userId) });
    return { ok: true };
  });

  // ---- branch settings ----
  r.get('/api/branch', A.requireBranch, (ctx) => ctx.branch);
  r.patch('/api/branch', MANAGE, (ctx) => {
    const allowed = ['name', 'offices', 'job_prefix', 'vo_approval_threshold', 'claim_response_days', 'vo_response_days', 'gst_rate', 'currency'];
    const sets = []; const vals = [];
    for (const k of allowed) if (k in ctx.body) { sets.push(`${k} = ?`); vals.push(ctx.body[k]); }
    if (!sets.length) throw new HttpError(400, 'Nothing to update');
    ctx.db.prepare(`UPDATE branches SET ${sets.join(', ')} WHERE id = ?`).run(...vals, ctx.branch.id);
    A.audit(ctx, 'branch.settings', 'branch', ctx.branch.id, ctx.body);
    return ctx.db.prepare('SELECT * FROM branches WHERE id = ?').get(ctx.branch.id);
  });

  // ---- audit log (branch managers see their branch; group admins see all) ----
  r.get('/api/audit', A.requireUser, (ctx) => {
    const lim = Math.min(500, Number(ctx.query.limit) || 100);
    if (ctx.role === 'group_admin' && !ctx.branch) {
      return ctx.db.prepare(`SELECT a.*, u.name user_name, b.code branch_code FROM audit_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN branches b ON b.id = a.branch_id ORDER BY a.at DESC LIMIT ?`).all(lim);
    }
    A.requireRole('branch_manager', 'finance')(ctx);
    return ctx.db.prepare(`SELECT a.*, u.name user_name, b.code branch_code FROM audit_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN branches b ON b.id = a.branch_id
      WHERE a.branch_id = ? ORDER BY a.at DESC LIMIT ?`).all(ctx.branch.id, lim);
  });

  // ---- group view (directors) ----
  r.get('/api/group/overview', A.requireGroupAdmin, (ctx) => {
    const branches = ctx.db.prepare('SELECT * FROM branches ORDER BY id').all();
    const out = branches.map(b => {
      const bm = ctx.db.prepare(`SELECT u.name FROM branch_members m JOIN users u ON u.id = m.user_id WHERE m.branch_id = ? AND m.role = 'branch_manager' ORDER BY u.name`).all(b.id).map(x => x.name);
      const projects = ctx.db.prepare("SELECT * FROM projects WHERE branch_id = ? AND status = 'live'").all(b.id).map(p => ({ ...p, summary: projectSummary(ctx.db, p) }));
      const t = projects.reduce((t, p) => { const s = p.summary; t.contract += s.contract_total; t.claimed += s.claimed; t.forecast += s.cost.forecast; t.actual += s.cost.actual; t.open_vo += s.open_vo_amt; t.open_vo_n += s.open_vo_n; return t; },
        { contract: 0, claimed: 0, forecast: 0, actual: 0, open_vo: 0, open_vo_n: 0 });
      const prog = ctx.db.prepare(`SELECT AVG(pct_complete) a FROM programme_stages WHERE project_id IN (SELECT id FROM projects WHERE branch_id = ? AND status = 'live')`).get(b.id).a;
      const unapproved = ctx.db.prepare("SELECT COUNT(*) n FROM claims c JOIN projects p ON p.id = c.project_id WHERE p.branch_id = ? AND c.status = 'internal_review'").get(b.id).n;
      const users = ctx.db.prepare('SELECT COUNT(*) n FROM branch_members WHERE branch_id = ?').get(b.id).n;
      return { ...b, branch_managers: bm, active_jobs: projects.length, users, totals: { ...t, forecast_margin_pct: t.contract ? (t.contract - t.forecast) / t.contract : null }, programme_health: prog || 0, unapproved_claims: unapproved };
    });
    out.sort((a, b) => b.totals.contract - a.totals.contract);
    const g = out.reduce((g, b) => { g.contract += b.totals.contract; g.claimed += b.totals.claimed; g.forecast += b.totals.forecast; g.open_vo += b.totals.open_vo; g.open_vo_n += b.totals.open_vo_n; g.jobs += b.active_jobs; g.unapproved += b.unapproved_claims; return g; },
      { contract: 0, claimed: 0, forecast: 0, open_vo: 0, open_vo_n: 0, jobs: 0, unapproved: 0 });
    g.forecast_margin_pct = g.contract ? (g.contract - g.forecast) / g.contract : null;
    return { branches: out, group: g, note: 'NZ figures shown in NZD; FX conversion to be added when the NZ branch is onboarded.' };
  });

  r.get('/api/group/branches', A.requireGroupAdmin, (ctx) => ctx.db.prepare('SELECT * FROM branches ORDER BY id').all());
  r.post('/api/group/branches', A.requireGroupAdmin, (ctx) => {
    const b = ctx.body;
    if (!b.code || !b.name || !b.country) throw new HttpError(400, 'code, name, country required');
    const info = ctx.db.prepare('INSERT INTO branches (code, name, country, currency, gst_rate, offices, job_prefix, status) VALUES (?,?,?,?,?,?,?,?)')
      .run(b.code.toUpperCase(), b.name, b.country, b.currency || 'AUD', b.gst_rate ?? 0.10, b.offices || null, b.job_prefix || null, b.status || 'onboarding');
    A.audit(ctx, 'branch.create', 'branch', Number(info.lastInsertRowid), b);
    ctx.status = 201;
    return ctx.db.prepare('SELECT * FROM branches WHERE id = ?').get(Number(info.lastInsertRowid));
  });
  // Directors can appoint a branch manager for any branch (bootstrap for new states, e.g. WA)
  r.post('/api/group/branches/:id/members', A.requireGroupAdmin, (ctx) => {
    const bid = Number(ctx.params.id); const { email, name, role } = ctx.body;
    if (!A.ROLES.includes(role)) throw new HttpError(400, 'Invalid role');
    let u = ctx.db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    let temp;
    if (!u) { temp = require('node:crypto').randomBytes(6).toString('base64url'); const initials = (name || email).split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
      u = { id: Number(ctx.db.prepare('INSERT INTO users (email, name, initials, password_hash) VALUES (?,?,?,?)').run(email, name || email, initials, A.hashPassword(temp)).lastInsertRowid) }; }
    ctx.db.prepare('INSERT INTO branch_members (user_id, branch_id, role) VALUES (?,?,?) ON CONFLICT(user_id, branch_id) DO UPDATE SET role = excluded.role').run(u.id, bid, role);
    A.audit(ctx, 'user.add_to_branch', 'user', u.id, { branch_id: bid, role });
    return { id: u.id, temp_password: temp };
  });
};
