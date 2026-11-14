'use strict';
// Nightly SQLite backup (and on start) to <data dir>/backups, keeping the last 14. Uses SQLite's online backup via VACUUM INTO.
const fs = require('node:fs');
const path = require('node:path');
const { DB_PATH } = require('./db');

function backup(db) {
  if (DB_PATH === ':memory:') return;
  const dir = path.join(path.dirname(DB_PATH), 'backups'); fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const file = path.join(dir, `rosk-${stamp}.sqlite`);
  try {
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const olds = fs.readdirSync(dir).filter(f => f.startsWith('rosk-')).sort().reverse().slice(14);
    for (const f of olds) fs.unlinkSync(path.join(dir, f));
    console.log(`[backup] ${file}`);
  } catch (e) { console.error('[backup] failed', e.message); }
}
function schedule(db) {
  backup(db);
  const msToNext = () => { const d = new Date(); const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 16, 0, 0)); return n - d; }; // 03:00 AEDT
  const tick = () => { backup(db); setTimeout(tick, msToNext()); };
  setTimeout(tick, msToNext());
}
module.exports = { backup, schedule };
