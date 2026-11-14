'use strict';
const { HttpError } = require('../http');
const A = require('../auth');

module.exports = (r) => {
  r.post('/api/auth/login', (ctx) => {
    const { email, password } = ctx.body;
    const u = ctx.db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(String(email || ''));
    if (!u || !A.verifyPassword(String(password || ''), u.password_hash)) throw new HttpError(401, 'Email or password incorrect');
    const sid = A.createSession(ctx.db, u.id);
    ctx.res.setHeader('Set-Cookie', `psg_session=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${12 * 3600}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    ctx.user = { id: u.id }; ctx.db.prepare('INSERT INTO audit_log (user_id, action, detail) VALUES (?, ?, ?)').run(u.id, 'login', null);
    return { ok: true };
  });

  r.post('/api/auth/logout', (ctx) => {
    if (ctx.sid) A.destroySession(ctx.db, ctx.sid);
    ctx.res.setHeader('Set-Cookie', 'psg_session=; HttpOnly; Path=/; Max-Age=0');
    return { ok: true };
  });

  // Who am I, which branches can I enter, which one am I in.
  r.get('/api/me', (ctx) => {
    A.requireUser(ctx);
    const all = ctx.company ? ctx.db.prepare('SELECT id, code, name, country, currency, status, offices FROM branches WHERE company_id = ? ORDER BY id').all(ctx.company.id) : [];
    const branches = all.map(b => {
      const m = ctx.memberships.find(x => x.branch_id === b.id);
      return { ...b, role: m ? m.role : (ctx.user.is_group_admin ? 'group_admin' : null) };
    });
    return { user: ctx.user, company: ctx.company || null, branches, current_branch: ctx.branch || null, role: ctx.role || null };
  });

  // Platform admin: enter a customer company (acts as a director there). Pass null to leave.
  r.post('/api/auth/company', (ctx) => {
    A.requirePlatformAdmin(ctx);
    const cid = ctx.body.company_id == null ? null : Number(ctx.body.company_id);
    if (cid !== null && !ctx.db.prepare('SELECT 1 FROM companies WHERE id = ?').get(cid)) throw new HttpError(404, 'Company not found');
    ctx.db.prepare('UPDATE sessions SET company_id = ?, branch_id = NULL WHERE id = ?').run(cid, ctx.sid);
    ctx.db.prepare('INSERT INTO audit_log (user_id, action, detail) VALUES (?, ?, ?)').run(ctx.user.id, 'enter_company', JSON.stringify({ company_id: cid }));
    return { ok: true };
  });

  // Choose / switch branch. Pass branch_id = null for the group view (directors only).
  r.post('/api/auth/branch', (ctx) => {
    A.requireUser(ctx);
    const bid = ctx.body.branch_id == null ? null : Number(ctx.body.branch_id);
    if (bid === null) {
      if (!ctx.user.is_group_admin) throw new HttpError(403, 'Group view is for directors');
    } else {
      const inCompany = ctx.company && ctx.db.prepare('SELECT 1 FROM branches WHERE id = ? AND company_id = ?').get(bid, ctx.company.id);
      const allowed = inCompany && (ctx.user.is_group_admin || ctx.memberships.some(m => m.branch_id === bid));
      if (!allowed) throw new HttpError(403, 'You are not a member of that branch');
    }
    ctx.db.prepare('UPDATE sessions SET branch_id = ? WHERE id = ?').run(bid, ctx.sid);
    ctx.db.prepare('INSERT INTO audit_log (user_id, branch_id, action) VALUES (?, ?, ?)').run(ctx.user.id, bid, 'switch_branch');
    return { ok: true };
  });
};
