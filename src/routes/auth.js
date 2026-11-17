'use strict';
const { HttpError } = require('../http');
const A = require('../auth');
const Co = require('../company');
const TZ = require('../tz');

module.exports = (r) => {
  // Public: what the sign-in page needs to know about this instance.
  const SIGNUP = () => (process.env.ROSK_SIGNUP || 'invite'); // open | invite | off
  const inviteFor = (db, code) => {
    if (!code) return null;
    const inv = db.prepare('SELECT * FROM signup_invites WHERE code = ?').get(String(code).trim());
    if (!inv) throw new HttpError(404, 'That invite link is not valid');
    if (inv.uses >= inv.max_uses) throw new HttpError(410, 'That invite link has already been used');
    if (inv.expires_at && inv.expires_at < new Date().toISOString().slice(0, 10)) throw new HttpError(410, 'That invite link has expired');
    return inv;
  };
  r.get('/api/config', (ctx) => {
    const mode = SIGNUP(); let invite = null;
    if (mode === 'invite' && ctx.query.code) { try { const inv = inviteFor(ctx.db, ctx.query.code); invite = { ok: true, note: inv.note, trial_days: inv.trial_days }; } catch (e) { invite = { ok: false, error: e.message }; } }
    return { demo: (process.env.ROSK_SEED || 'demo') === 'demo', signup: mode, trial_days: Co.TRIAL_DAYS, brand: 'RōSK', invite };
  });

  // Self-service sign-up: a new company, its first branch and its first admin, on a 30-day trial. Signed in on success.
  r.post('/api/signup', (ctx) => {
    const mode = SIGNUP(); const b = ctx.body || {};
    if (mode === 'off') throw new HttpError(403, 'Sign-up is closed on this instance');
    const inv = mode === 'invite' ? inviteFor(ctx.db, b.code) : null;
    if (mode === 'invite' && !inv) throw new HttpError(403, 'An invite link is required to start a trial');
    const trialDays = inv ? inv.trial_days : Co.TRIAL_DAYS;
    const name = String(b.company_name || '').trim(), person = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
    if (name.length < 2) throw new HttpError(400, 'Company name required');
    if (person.length < 2) throw new HttpError(400, 'Your name is required');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'A valid work email is required');
    if (pw.length < 10) throw new HttpError(400, 'Password must be at least 10 characters');
    if (ctx.db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'That email already has a RōSK login — sign in instead');
    const country = ['AU', 'NZ', 'SG', 'JP', 'AE', 'GB', 'US'].includes(b.country) ? b.country : 'AU';
    const CUR = { AU: ['AUD', 0.10], NZ: ['NZD', 0.15], SG: ['SGD', 0.09], JP: ['JPY', 0.10], AE: ['AED', 0.05], GB: ['GBP', 0.20], US: ['USD', 0] };
    const code = String(b.branch_code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) || (country === 'AU' ? 'VIC' : country);
    const branchName = String(b.branch_name || '').trim() || (country === 'AU' ? 'Head office' : country);
    const ends = new Date(Date.now() + trialDays * 86400000).toISOString().slice(0, 10);
    const disciplines = Co.cleanList(b.disciplines, Co.DEFAULT_DISCIPLINES);
    const tx = ctx.db;
    const cid = Number(tx.prepare('INSERT INTO companies (name, short_name, trades, plan, country, accounting, disciplines, trade_list, trial_ends_at, signup_source) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(name, String(b.short_name || '').trim() || name.split(/\s+/).slice(0, 2).join(' '), disciplines.join(' · '), inv ? inv.plan : 'trial', country, String(b.accounting || '').trim() || null, JSON.stringify(disciplines), JSON.stringify(Co.cleanList(b.trades, [...disciplines, 'Office'])), ends, inv ? 'invite:' + inv.code : 'self-service').lastInsertRowid);
    const bid = Number(tx.prepare('INSERT INTO branches (company_id, code, name, country, currency, gst_rate, status, job_prefix, timezone) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(cid, code, branchName, country, CUR[country][0], CUR[country][1], 'live', code, b.timezone || null).lastInsertRowid);
    const initials = person.split(/\s+/).map(x => x[0]).join('').slice(0, 2).toUpperCase();
    const uid = Number(tx.prepare('INSERT INTO users (company_id, email, name, initials, password_hash, is_group_admin, employment_type, home_branch_id) VALUES (?,?,?,?,?,1,?,?)').run(cid, email, person, initials, A.hashPassword(pw), 'salary', bid).lastInsertRowid);
    tx.prepare('INSERT INTO branch_members (user_id, branch_id, role) VALUES (?,?,?)').run(uid, bid, 'branch_manager');
    tx.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?)').run(uid, 'company.signup', 'company', cid, JSON.stringify({ name, country, code }));
    if (inv) tx.prepare('UPDATE signup_invites SET uses = uses + 1, used_by_company_id = ? WHERE id = ?').run(cid, inv.id);
    const sid = A.createSession(tx, uid);
    ctx.res.setHeader('Set-Cookie', `psg_session=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${12 * 3600}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    ctx.status = 201; return { ok: true, company_id: cid, branch_id: bid, trial_ends_at: ends };
  });

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
    return { user: ctx.user, company: ctx.company || null, settings: Co.settings(ctx.company), branches, current_branch: ctx.branch ? { ...ctx.branch, timezone: TZ.tzFor(ctx.branch) } : null, role: ctx.role || null };
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
