'use strict';
// Onboarding (per company; public page via token + QR), toolbox talks (supervisor portal), file attachments.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError, send } = require('../http');
const A = require('../auth');
const qr = require('../qr');

const FILES_DIR = process.env.PSG_FILES || path.join(__dirname, '..', '..', 'data', 'files');
const MAX_FILE = 8 * 1024 * 1024;
const ALLOWED_MIME = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain|application\/(msword|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)))$/;

function ensureOnboarding(db, companyId) {
  let o = db.prepare('SELECT * FROM onboarding WHERE company_id = ?').get(companyId);
  if (!o) { db.prepare('INSERT INTO onboarding (company_id, token, welcome, video_links, uniform_link, timesheet_instructions, contacts, documents, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime(\'now\'))')
    .run(companyId, crypto.randomBytes(8).toString('hex'), '', '[]', '', '', '[]', '[]'); o = db.prepare('SELECT * FROM onboarding WHERE company_id = ?').get(companyId); }
  return { ...o, video_links: JSON.parse(o.video_links || '[]'), contacts: JSON.parse(o.contacts || '[]'), documents: JSON.parse(o.documents || '[]') };
}
function baseUrl(ctx) { const h = ctx.req.headers['x-forwarded-host'] || ctx.req.headers.host || 'localhost:3000'; const proto = ctx.req.headers['x-forwarded-proto'] || 'http'; return `${proto}://${h}`; }

// Save a base64 upload. Body: { name, mime, data (base64) }
function saveFile(ctx, entity, entityId, f) {
  if (!f || !f.name || !f.data) throw new HttpError(400, 'file name and data required');
  if (!ALLOWED_MIME.test(f.mime || '')) throw new HttpError(400, 'File type not allowed (PDF, images, Word, Excel, PowerPoint, text)');
  const buf = Buffer.from(f.data, 'base64'); if (buf.length > MAX_FILE) throw new HttpError(413, 'File over 8 MB');
  fs.mkdirSync(path.join(FILES_DIR, String(ctx.company.id)), { recursive: true });
  const safe = f.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80); const rel = path.join(String(ctx.company.id), `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safe}`);
  fs.writeFileSync(path.join(FILES_DIR, rel), buf);
  const info = ctx.db.prepare('INSERT INTO files (company_id, entity, entity_id, name, mime, size, path, uploaded_by) VALUES (?,?,?,?,?,?,?,?)').run(ctx.company.id, entity, entityId, f.name, f.mime, buf.length, rel, ctx.user.id);
  return Number(info.lastInsertRowid);
}
const filesFor = (db, entity, id) => db.prepare('SELECT id, name, mime, size, created_at FROM files WHERE entity = ? AND entity_id = ? ORDER BY id').all(entity, id);

module.exports = (r) => {
  // ---- onboarding admin ----
  r.get('/api/onboarding', A.requireUser, (ctx) => {
    if (!ctx.company) throw new HttpError(403, 'Choose a company first');
    const o = ensureOnboarding(ctx.db, ctx.company.id); const url = `${baseUrl(ctx)}/onboard/${o.token}`;
    return { ...o, url, qr_svg: qr.svg(url, 220), files: filesFor(ctx.db, 'onboarding', ctx.company.id) };
  });
  r.put('/api/onboarding', A.requireUser, (ctx) => {
    if (!(ctx.user.is_group_admin || ctx.role === 'branch_manager')) throw new HttpError(403, 'Directors or Branch Managers');
    ensureOnboarding(ctx.db, ctx.company.id); const b = ctx.body;
    ctx.db.prepare('UPDATE onboarding SET welcome = ?, video_links = ?, uniform_link = ?, timesheet_instructions = ?, contacts = ?, updated_at = datetime(\'now\') WHERE company_id = ?')
      .run(b.welcome || '', JSON.stringify(b.video_links || []), b.uniform_link || '', b.timesheet_instructions || '', JSON.stringify(b.contacts || []), ctx.company.id);
    A.audit(ctx, 'onboarding.update', 'company', ctx.company.id);
    return { ok: true };
  });
  r.post('/api/onboarding/regenerate', A.requireUser, (ctx) => {
    if (!(ctx.user.is_group_admin || ctx.role === 'branch_manager')) throw new HttpError(403, 'Directors or Branch Managers');
    ctx.db.prepare('UPDATE onboarding SET token = ? WHERE company_id = ?').run(crypto.randomBytes(8).toString('hex'), ctx.company.id);
    A.audit(ctx, 'onboarding.regenerate_link', 'company', ctx.company.id); return { ok: true };
  });
  r.post('/api/onboarding/files', A.requireUser, (ctx) => {
    if (!(ctx.user.is_group_admin || ctx.role === 'branch_manager')) throw new HttpError(403, 'Directors or Branch Managers');
    const id = saveFile(ctx, 'onboarding', ctx.company.id, ctx.body); return { id };
  });

  // ---- public onboarding page (no login) ----
  r.get('/onboard/:token', (ctx) => {
    const o = ctx.db.prepare('SELECT o.*, c.name company_name, c.trades FROM onboarding o JOIN companies c ON c.id = o.company_id WHERE o.token = ?').get(ctx.params.token);
    if (!o) { send(ctx.res, 404, '<h1>Link not found</h1>', { 'Content-Type': 'text/html' }); return; }
    const esc = (x) => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const videos = JSON.parse(o.video_links || '[]'); const contacts = JSON.parse(o.contacts || '[]');
    const files = filesFor(ctx.db, 'onboarding', o.company_id);
    const yt = (u) => { const m = /(?:youtu\.be\/|v=|embed\/)([\w-]{11})/.exec(u || ''); return m ? `https://www.youtube.com/embed/${m[1]}` : null; };
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welcome to ${esc(o.company_name)}</title>
<style>body{margin:0;font-family:Inter,system-ui,sans-serif;background:#F4F4F5;color:#17181B}header{background:#0F1012;color:#fff;padding:28px 20px}header h1{margin:0;font-size:24px}header p{margin:6px 0 0;color:#B9BBC2}main{max-width:720px;margin:0 auto;padding:20px;display:flex;flex-direction:column;gap:16px}section{background:#fff;border:1px solid #E3E4E7;border-radius:8px;padding:18px}h2{margin:0 0 10px;font-size:16px}p,li{line-height:1.6;font-size:15px}a{color:#C8102E}.btn{display:inline-block;background:#C8102E;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none;font-weight:600}iframe{width:100%;aspect-ratio:16/9;border:0;border-radius:6px}.step{display:flex;gap:12px;align-items:flex-start;margin:10px 0}.step i{flex:none;width:26px;height:26px;border-radius:50%;background:#0F1012;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-style:normal;font-weight:700;font-size:13px}footer{text-align:center;color:#6B6E76;font-size:12px;padding:20px}</style></head><body>
<header><h1>Welcome to ${esc(o.company_name)}</h1><p>${esc(o.trades || '')} · New starter onboarding</p></header><main>
${o.welcome ? `<section><h2>Welcome</h2><p style="white-space:pre-line">${esc(o.welcome)}</p></section>` : ''}
${videos.length ? `<section><h2>About the business</h2>${videos.map(v => yt(v.url) ? `<p><b>${esc(v.title)}</b></p><iframe src="${yt(v.url)}" allowfullscreen title="${esc(v.title)}"></iframe>` : `<p><a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(v.title || v.url)}</a></p>`).join('')}</section>` : ''}
${o.uniform_link ? `<section><h2>Uniform &amp; PPE</h2><p>Order your uniform and PPE before your first day.</p><a class="btn" href="${esc(o.uniform_link)}" target="_blank" rel="noopener">Order uniform →</a></section>` : ''}
<section><h2>Timesheets — signing in and out each day</h2>${o.timesheet_instructions ? `<p style="white-space:pre-line">${esc(o.timesheet_instructions)}</p>` : ''}
<div class="step"><i>1</i><div>Open RōSK on your phone and sign in with the account you'll be sent on your first day.</div></div>
<div class="step"><i>2</i><div>Each morning, open <b>My timesheet</b>, pick the job you're on and tap <b>Sign in</b>.</div></div>
<div class="step"><i>3</i><div>Moving jobs during the day? Sign out, then sign in to the next one — time is costed to each job.</div></div>
<div class="step"><i>4</i><div>At the end of the day tap <b>Sign out</b>. Your break is deducted automatically. Submit your week on Friday.</div></div></section>
${files.length ? `<section><h2>Documents</h2><ul>${files.map(f => `<li><a href="/onboard/${esc(o.token)}/file/${f.id}">${esc(f.name)}</a></li>`).join('')}</ul></section>` : ''}
${contacts.length ? `<section><h2>Who to contact</h2>${contacts.map(c => `<p><b>${esc(c.name)}</b> — ${esc(c.role)}${c.phone ? ` · <a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ''}${c.email ? ` · <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</p>`).join('')}</section>` : ''}
</main><footer>Powered by RōSK</footer></body></html>`;
    send(ctx.res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
  });
  r.get('/onboard/:token/file/:id', (ctx) => {
    const o = ctx.db.prepare('SELECT company_id FROM onboarding WHERE token = ?').get(ctx.params.token); if (!o) throw new HttpError(404, 'Not found');
    const f = ctx.db.prepare("SELECT * FROM files WHERE id = ? AND entity = 'onboarding' AND entity_id = ?").get(Number(ctx.params.id), o.company_id); if (!f) throw new HttpError(404, 'Not found');
    streamFile(ctx, f);
  });

  function streamFile(ctx, f) {
    const abs = path.join(FILES_DIR, f.path); if (!fs.existsSync(abs)) throw new HttpError(404, 'File missing');
    ctx.res.writeHead(200, { 'Content-Type': f.mime || 'application/octet-stream', 'Content-Disposition': `inline; filename="${f.name.replace(/"/g, '')}"`, 'Content-Length': f.size });
    fs.createReadStream(abs).pipe(ctx.res);
  }
  r.get('/api/files/:id', A.requireUser, (ctx) => {
    const f = ctx.db.prepare('SELECT * FROM files WHERE id = ? AND company_id = ?').get(Number(ctx.params.id), ctx.company?.id); if (!f) throw new HttpError(404, 'Not found');
    if (f.entity === 'toolbox') { const t = ctx.db.prepare('SELECT project_id FROM toolbox_talks WHERE id = ?').get(f.entity_id); if (t) A.loadProject(ctx, t.project_id); }
    streamFile(ctx, f);
  });

  // ---- toolbox talks ----
  r.get('/api/toolbox', A.requireBranch, (ctx) => {
    const s = A.projectScope(ctx); const where = [s.sql]; const params = [...s.params];
    if (ctx.query.project_id) { where.push('p.id = ?'); params.push(Number(ctx.query.project_id)); }
    const rows = ctx.db.prepare(`SELECT t.*, p.number project_number, p.name project_name, u.name presenter_name FROM toolbox_talks t JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.presenter_id
      WHERE ${where.join(' AND ')} ORDER BY t.held_on DESC, t.id DESC LIMIT 200`).all(...params);
    return rows.map(t => ({ ...t, attendees: JSON.parse(t.attendees || '[]'), files: filesFor(ctx.db, 'toolbox', t.id) }));
  });
  r.post('/api/projects/:id/toolbox', A.requireRole('supervisor', 'pm', 'branch_manager'), (ctx) => {
    const p = A.loadProject(ctx, ctx.params.id); A.requireWrite(ctx, p); const b = ctx.body;
    if (!b.topic || !b.held_on) throw new HttpError(400, 'topic and held_on required');
    const attendees = Array.isArray(b.attendees) ? b.attendees : [];
    const info = ctx.db.prepare('INSERT INTO toolbox_talks (project_id, held_on, topic, presenter_id, notes, hazards, actions, attendees, attendee_count) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(p.id, b.held_on, b.topic, b.presenter_id || ctx.user.id, b.notes || null, b.hazards || null, b.actions || null, JSON.stringify(attendees), attendees.length);
    const id = Number(info.lastInsertRowid);
    for (const f of b.files || []) saveFile(ctx, 'toolbox', id, f);
    A.audit(ctx, 'toolbox.create', 'toolbox', id, { project: p.number, topic: b.topic, attendees: attendees.length });
    ctx.status = 201; return { id };
  });
  r.post('/api/toolbox/:id/files', A.requireRole('supervisor', 'pm', 'branch_manager'), (ctx) => {
    const t = ctx.db.prepare('SELECT * FROM toolbox_talks WHERE id = ?').get(Number(ctx.params.id)); if (!t) throw new HttpError(404, 'Not found');
    const p = A.loadProject(ctx, t.project_id); A.requireWrite(ctx, p);
    return { id: saveFile(ctx, 'toolbox', t.id, ctx.body) };
  });
  r.delete('/api/toolbox/:id', A.requireRole('supervisor', 'pm', 'branch_manager'), (ctx) => {
    const t = ctx.db.prepare('SELECT * FROM toolbox_talks WHERE id = ?').get(Number(ctx.params.id)); if (!t) throw new HttpError(404, 'Not found');
    const p = A.loadProject(ctx, t.project_id); A.requireWrite(ctx, p);
    ctx.db.prepare('DELETE FROM toolbox_talks WHERE id = ?').run(t.id); ctx.db.prepare("DELETE FROM files WHERE entity = 'toolbox' AND entity_id = ?").run(t.id);
    A.audit(ctx, 'toolbox.delete', 'toolbox', t.id); return { ok: true };
  });
  // people who can be attendees on a job: everyone with access + branch members (so supervisors can tick anyone on site)
  r.get('/api/projects/:id/people', A.requireBranch, (ctx) => {
    const p = A.loadProject(ctx, ctx.params.id);
    return ctx.db.prepare(`SELECT DISTINCT u.id, u.name, u.initials, u.trade FROM users u JOIN branch_members m ON m.user_id = u.id WHERE m.branch_id = ? AND u.active = 1 ORDER BY u.name`).all(p.branch_id);
  });
};
