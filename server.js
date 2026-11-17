'use strict';
// PSG Project Controls — entry point.  Run: node server.js   (Node 22.13+; no dependencies)
const path = require('node:path');
const { open } = require('./src/db');
const { Router, serveStatic, createServer } = require('./src/http');
const { loadSession } = require('./src/auth');

function buildApp(dbFile) {
  const db = open(dbFile);
  const r = new Router();
  r.use(loadSession(db));
  require('./src/routes/auth')(r);
  require('./src/routes/projects')(r);
  require('./src/routes/variations')(r);
  require('./src/routes/claims')(r);
  require('./src/routes/admin')(r);
  require('./src/routes/insights')(r);
  require('./src/routes/people')(r);
  require('./src/routes/site')(r);
  r.get('/api/health', () => ({ ok: true, time: new Date().toISOString() }));
  r.get('/.*', serveStatic(path.join(__dirname, 'public')));
  return { router: r, db };
}

if (require.main === module) {
  const { router, db } = buildApp();
  const PROD = process.env.NODE_ENV === 'production';
  const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (!users) {
    if ((process.env.ROSK_SEED || 'demo') === 'demo') { console.log('Empty database — seeding demo data.'); require('./scripts/seed').seed(db); }
    else { console.log('Empty database — creating platform admin only.'); require('./scripts/seed').seedAdminOnly(db); }
  }
  // Production: platform admin password comes from the environment, never the seed default.
  if (PROD) {
    const pw = process.env.ROSK_ADMIN_PASSWORD;
    if (!pw) { console.error('ROSK_ADMIN_PASSWORD must be set in production.'); process.exit(1); }
    db.prepare('UPDATE users SET password_hash = ? WHERE is_platform_admin = 1').run(require('./src/auth').hashPassword(pw));
    if (process.env.ROSK_DEMO_PASSWORD) db.prepare('UPDATE users SET password_hash = ? WHERE is_platform_admin = 0').run(require('./src/auth').hashPassword(process.env.ROSK_DEMO_PASSWORD));
    require('./src/backup').schedule(db);
  }
  // Demo data: keep today's sign-ins coming so attendance and timesheets show a live day (demo tenants only).
  if ((process.env.ROSK_SEED || 'demo') === 'demo') require('./scripts/seed-today').schedule(db, (m) => console.log(m));
  const port = Number(process.env.PORT || 3000);
  createServer(router).listen(port, () => console.log(`RōSK running at http://localhost:${port}${PROD ? ' (production)' : ''}`));
}

module.exports = { buildApp };
