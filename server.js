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
  const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (!users) { console.log('Empty database — seeding sample data (run `npm run reset` to re-seed).'); require('./scripts/seed').seed(db); }
  const port = Number(process.env.PORT || 3000);
  createServer(router).listen(port, () => console.log(`PSG Project Controls running at http://localhost:${port}`));
}

module.exports = { buildApp };
