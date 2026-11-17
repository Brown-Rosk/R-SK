'use strict';
// Per-company configuration. RōSK is sold to any contractor, so the lists that describe a business — its disciplines
// (how jobs and variations are categorised) and its trades (how people and wage rates are grouped) — belong to the
// company, with sensible defaults for a building-services contractor.
const DEFAULT_DISCIPLINES = ['Fire', 'Mechanical', 'Electrical', 'Hydraulic'];
const DEFAULT_TRADES = ['Fire', 'Mechanical', 'Electrical', 'Hydraulic', 'Office'];
const PLANS = { trial: 'Trial', standard: 'Standard', enterprise: 'Enterprise', pilot: 'Pilot' };
const TRIAL_DAYS = 30;

function parseList(text, fallback) {
  if (!text) return fallback.slice();
  try { const v = JSON.parse(text); if (Array.isArray(v) && v.length) return v.map(String); } catch (e) { /* legacy "A · B" text */ }
  const parts = String(text).split(/[·,;/]/).map(x => x.trim()).filter(Boolean);
  return parts.length ? parts : fallback.slice();
}
function cleanList(v, fallback) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,\n·;]/);
  const out = []; for (const x of arr) { const t = String(x).trim().slice(0, 40); if (t && !out.some(o => o.toLowerCase() === t.toLowerCase())) out.push(t); }
  return out.length ? out : fallback.slice();
}
function keyOf(label) { return String(label || '').trim().toLowerCase(); }

function settings(company) {
  if (!company) return { disciplines: DEFAULT_DISCIPLINES.slice(), trades: DEFAULT_TRADES.slice(), plan: 'standard', trial: null };
  const disciplines = parseList(company.disciplines, DEFAULT_DISCIPLINES);
  const trades = parseList(company.trade_list, DEFAULT_TRADES);
  const today = new Date().toISOString().slice(0, 10);
  const trial = company.plan === 'trial' ? { ends_at: company.trial_ends_at, days_left: company.trial_ends_at ? Math.ceil((Date.parse(company.trial_ends_at) - Date.parse(today)) / 86400000) : null, expired: !!company.trial_ends_at && company.trial_ends_at < today } : null;
  return { disciplines, trades, discipline_keys: disciplines.map(keyOf), plan: company.plan, plan_label: PLANS[company.plan] || company.plan, trial };
}

module.exports = { settings, cleanList, keyOf, DEFAULT_DISCIPLINES, DEFAULT_TRADES, TRIAL_DAYS, PLANS };
