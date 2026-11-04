'use strict';
// Authentication, sessions, branch context and the permission model.
//
//  Branch is the hard boundary: every project belongs to one branch and every query is
//  filtered by the session's current branch. Within a branch:
//    branch_manager, finance            -> see every project in the branch
//    pm, supervisor, estimator          -> see only projects granted in project_access
//  is_group_admin users (directors/CEO/CFO) can enter any branch and the group view.
const crypto = require('node:crypto');
const { HttpError } = require('./http');

const SESSION_TTL_H = 12;
const ROLES = ['field', 'supervisor', 'pm', 'estimator', 'branch_manager', 'finance']; // field = site staff: timesheets, attendance of own job, toolbox attendance only
const SEES_ALL_BRANCH = new Set(['branch_manager', 'finance']);

// ---- passwords (scrypt; swap for Microsoft 365 SSO later without touching routes) ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), test);
}

// ---- sessions ----
function createSession(db, userId) {
  const id = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_TTL_H} hours'))`).run(id, userId);
  return id;
}
function destroySession(db, id) { db.prepare('DELETE FROM sessions WHERE id = ?').run(id); }

function loadSession(db) {
  return (ctx) => {
    ctx.db = db;
    const sid = ctx.cookies.psg_session;
    if (!sid) return;
    const s = db.prepare(`SELECT s.id sid, s.branch_id, s.company_id session_company, u.* FROM sessions s JOIN users u ON u.id = s.user_id
                          WHERE s.id = ? AND s.expires_at > datetime('now') AND u.active = 1`).get(sid);
    if (!s) return;
    ctx.user = { id: s.id, email: s.email, name: s.name, initials: s.initials, is_group_admin: !!s.is_group_admin, is_platform_admin: !!s.is_platform_admin, company_id: s.company_id };
    ctx.sid = s.sid;
    // Company context: a user's own company, or (platform admin only) the company they have entered.
    const companyId = s.is_platform_admin && s.session_company ? s.session_company : s.company_id;
    ctx.company = companyId ? db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId) : null;
    if (s.is_platform_admin && s.session_company) ctx.user.is_group_admin = true; // platform admin acts as a director inside a company
    ctx.memberships = db.prepare(`SELECT bm.branch_id, bm.role, b.code, b.name FROM branch_members bm
                                  JOIN branches b ON b.id = bm.branch_id WHERE bm.user_id = ?`).all(s.id);
    if (s.branch_id) {
      ctx.branch = db.prepare('SELECT * FROM branches WHERE id = ? AND company_id = ?').get(s.branch_id, companyId);
      if (!ctx.branch) return; // branch outside the current company context
      const m = ctx.memberships.find(x => x.branch_id === s.branch_id);
      ctx.role = m ? m.role : (ctx.user.is_group_admin ? 'group_admin' : null);
    } else if (ctx.user.is_group_admin) {
      ctx.role = 'group_admin'; // group view, no branch selected
    }
  };
}

// ---- guards ----
function requireUser(ctx) { if (!ctx.user) throw new HttpError(401, 'Sign in required'); }
function requireBranch(ctx) {
  requireUser(ctx);
  if (!ctx.branch || !ctx.role) throw new HttpError(403, 'Choose a branch first');
}
function requireRole(...roles) {
  return (ctx) => {
    requireBranch(ctx);
    if (ctx.role === 'group_admin') return;
    if (!roles.includes(ctx.role)) throw new HttpError(403, `Requires role: ${roles.join(' or ')}`);
  };
}
function requireGroupAdmin(ctx) { requireUser(ctx); if (!ctx.user.is_group_admin) throw new HttpError(403, 'Directors only'); if (!ctx.company) throw new HttpError(403, 'Choose a company first'); }
function requirePlatformAdmin(ctx) { requireUser(ctx); if (!ctx.user.is_platform_admin) throw new HttpError(403, 'RōSK platform administrators only'); }

function seesWholeBranch(ctx) { return ctx.role === 'group_admin' || SEES_ALL_BRANCH.has(ctx.role); }

// SQL fragment + params restricting projects to what this user may see in the current branch.
function projectScope(ctx, alias = 'p') {
  if (seesWholeBranch(ctx)) return { sql: `${alias}.branch_id = ?`, params: [ctx.branch.id] };
  return { sql: `${alias}.branch_id = ? AND ${alias}.id IN (SELECT project_id FROM project_access WHERE user_id = ?)`,
           params: [ctx.branch.id, ctx.user.id] };
}

// Load a project the user may see, or 404 (never 403 — don't confirm the job exists).
function loadProject(ctx, projectId) {
  const scope = projectScope(ctx);
  const p = ctx.db.prepare(`SELECT p.*, u.name lead_pm_name FROM projects p LEFT JOIN users u ON u.id = p.lead_pm_id
                            WHERE p.id = ? AND ${scope.sql}`).get(Number(projectId), ...scope.params);
  if (!p) throw new HttpError(404, 'Project not found');
  if (seesWholeBranch(ctx)) p.access_level = 'lead';
  else p.access_level = ctx.db.prepare('SELECT level FROM project_access WHERE project_id = ? AND user_id = ?').get(p.id, ctx.user.id).level;
  return p;
}
function requireWrite(ctx, project) {
  if (project.access_level === 'readonly') throw new HttpError(403, 'Read-only access to this job');
  if (ctx.role === 'field') throw new HttpError(403, 'Field staff can log time on this job but not change it');
  if (ctx.role === 'finance') throw new HttpError(403, 'Finance is read-only on jobs');
}

function audit(ctx, action, entity, entityId, detail) {
  ctx.db.prepare('INSERT INTO audit_log (user_id, branch_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?)')
    .run(ctx.user ? ctx.user.id : null, ctx.branch ? ctx.branch.id : null, action, entity || null, entityId || null,
         detail ? JSON.stringify(detail) : null);
}

module.exports = { ROLES, hashPassword, verifyPassword, createSession, destroySession, loadSession,
  requireUser, requireBranch, requireRole, requireGroupAdmin, requirePlatformAdmin, seesWholeBranch, projectScope, loadProject, requireWrite, audit };
