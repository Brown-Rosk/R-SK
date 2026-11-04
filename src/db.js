'use strict';
// Database: SQLite via Node's built-in node:sqlite. One file, WAL mode.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = process.env.PSG_DB || path.join(__dirname, '..', 'data', 'psg.sqlite');

let db;
function open(file = DB_PATH) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
  -- A company is a RōSK customer (tenant). Everything below it is isolated from every other company.
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, short_name TEXT, trades TEXT, plan TEXT NOT NULL DEFAULT 'pilot',
    country TEXT NOT NULL DEFAULT 'AU', accounting TEXT, status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')));

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, company_id INTEGER REFERENCES companies(id), email TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
    initials TEXT, password_hash TEXT, is_group_admin INTEGER NOT NULL DEFAULT 0, is_platform_admin INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));

  CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), code TEXT NOT NULL, name TEXT NOT NULL, country TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'AUD', gst_rate REAL NOT NULL DEFAULT 0.10, offices TEXT,
    job_prefix TEXT, vo_approval_threshold REAL NOT NULL DEFAULT 25000,
    claim_response_days INTEGER NOT NULL DEFAULT 10, vo_response_days INTEGER NOT NULL DEFAULT 21,
    status TEXT NOT NULL DEFAULT 'live', UNIQUE (company_id, code));

  -- role: supervisor | pm | estimator | branch_manager | finance
  CREATE TABLE IF NOT EXISTS branch_members (
    user_id INTEGER NOT NULL REFERENCES users(id), branch_id INTEGER NOT NULL REFERENCES branches(id),
    role TEXT NOT NULL, PRIMARY KEY (user_id, branch_id));

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), branch_id INTEGER, company_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY, branch_id INTEGER NOT NULL REFERENCES branches(id), number TEXT NOT NULL,
    name TEXT NOT NULL, client TEXT, head_contractor TEXT, lead_pm_id INTEGER REFERENCES users(id),
    contract_value REAL NOT NULL DEFAULT 0, retention_pct REAL NOT NULL DEFAULT 0.05,
    retention_cap_pct REAL NOT NULL DEFAULT 0.05, claim_day INTEGER NOT NULL DEFAULT 5,
    start_date TEXT, pc_date TEXT, status TEXT NOT NULL DEFAULT 'live',
    tender_margin_pct REAL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (branch_id, number));

  -- level: lead | member | readonly
  CREATE TABLE IF NOT EXISTS project_access (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id), level TEXT NOT NULL,
    granted_by INTEGER REFERENCES users(id), granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, user_id));

  CREATE TABLE IF NOT EXISTS cost_codes (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    code TEXT NOT NULL, name TEXT NOT NULL, budget REAL NOT NULL DEFAULT 0, committed REAL NOT NULL DEFAULT 0,
    actual REAL NOT NULL DEFAULT 0, forecast REAL NOT NULL DEFAULT 0, UNIQUE (project_id, code));

  -- schedule of values for the base contract
  CREATE TABLE IF NOT EXISTS sov_items (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    code TEXT NOT NULL, description TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0);

  CREATE TABLE IF NOT EXISTS programme_stages (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, pct_complete REAL NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0);

  -- status: draft | priced | submitted | approved | disputed | rejected
  CREATE TABLE IF NOT EXISTS variations (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER NOT NULL, title TEXT NOT NULL, source TEXT, discipline TEXT,
    status TEXT NOT NULL DEFAULT 'draft', labour_hours REAL DEFAULT 0, labour_amt REAL DEFAULT 0,
    materials_amt REAL DEFAULT 0, sub_plant_amt REAL DEFAULT 0, prelims_margin_amt REAL DEFAULT 0,
    submitted_amt REAL DEFAULT 0, approved_amt REAL, cost_to_date REAL DEFAULT 0, pct_done REAL DEFAULT 0,
    owner_id INTEGER REFERENCES users(id), client_ref TEXT, notes TEXT,
    raised_at TEXT NOT NULL DEFAULT (date('now')), submitted_at TEXT, approved_at TEXT, decided_at TEXT,
    UNIQUE (project_id, number));

  -- status: draft | internal_review | approved | served | certified
  CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER NOT NULL, period_end TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
    serve_by TEXT, served_at TEXT, certified_at TEXT, certified_amt REAL, payment_due TEXT,
    drafted_by INTEGER REFERENCES users(id), approved_by INTEGER REFERENCES users(id),
    notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (project_id, number));

  -- kind: base (ref_id -> sov_items) | variation (ref_id -> variations)
  CREATE TABLE IF NOT EXISTS claim_lines (
    id INTEGER PRIMARY KEY, claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, ref_id INTEGER NOT NULL, description TEXT NOT NULL, contract_amt REAL NOT NULL,
    prev_claimed REAL NOT NULL DEFAULT 0, this_claim REAL NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
    UNIQUE (claim_id, kind, ref_id));

  CREATE TABLE IF NOT EXISTS attention_items (
    id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tag TEXT NOT NULL, text TEXT NOT NULL, link TEXT, severity TEXT NOT NULL DEFAULT 'warn',
    resolved INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now')), user_id INTEGER, branch_id INTEGER,
    action TEXT NOT NULL, entity TEXT, entity_id INTEGER, detail TEXT);
  CREATE INDEX IF NOT EXISTS audit_branch ON audit_log(branch_id, at);
  `);
  // Guard against a database created by an older build.
  const cols = d.prepare("PRAGMA table_info('branches')").all().map(c => c.name);
  if (!cols.includes('company_id')) throw new Error('This database was created by an older version of RōSK. Delete the data folder (or set PSG_DB to a new path) and start again.');
}

module.exports = { open, DB_PATH };
