'use strict';
// Director / CFO insights: performance by PM, by discipline, and WIP (percentage-of-completion).
const { HttpError } = require('../http');
const A = require('../auth');
const { projectSummary } = require('./projects');

const Co = require('../company');
function disciplinesOf(ctx) { const s = Co.settings(ctx.company); return s.disciplines.map(l => ({ key: Co.keyOf(l), label: l })); }

// WIP for one project. Percentage of completion on cost: earned = contract * (actual / forecast).
function wipFor(db, p) {
  const s = projectSummary(db, p);
  const cost = s.cost; const forecast = cost.forecast || 0; const actual = cost.actual || 0;
  const pct_cost = forecast > 0 ? Math.min(1, actual / forecast) : 0;
  const contract = s.contract_total;
  const earned = contract * pct_cost;
  const claimed = s.claimed;
  const certified = db.prepare("SELECT COALESCE(SUM(certified_amt),0) a FROM claims WHERE project_id = ? AND status = 'certified'").get(p.id).a;
  const forecast_profit = contract - forecast;
  const profit_to_date = earned - actual;
  const wip = earned - claimed; // + underclaimed (asset) / − overclaimed = unearned revenue (liability)
  const retention_held = Math.min(p.retention_cap_pct * contract, p.retention_pct * claimed);
  return { ...s, pct_cost, earned, claimed, certified, forecast_profit, profit_to_date, wip, underclaimed: Math.max(0, wip), unearned: Math.max(0, -wip),
    retention_held, cost_to_complete: Math.max(0, forecast - actual), remaining_to_claim: contract - claimed };
}

// Scope for insights: company-wide for directors (any branch they are in or the company view); otherwise current branch.
function scopeProjects(ctx) {
  if (ctx.user.is_group_admin) {
    return ctx.db.prepare(`SELECT p.*, u.name lead_pm_name, b.code branch_code, b.name branch_name, b.currency FROM projects p
      JOIN branches b ON b.id = p.branch_id LEFT JOIN users u ON u.id = p.lead_pm_id WHERE b.company_id = ? AND p.status = 'live'
      ${ctx.query.branch_id ? 'AND b.id = ?' : ''} ORDER BY b.id, p.number`).all(ctx.company.id, ...(ctx.query.branch_id ? [Number(ctx.query.branch_id)] : []));
  }
  A.requireRole('branch_manager', 'finance')(ctx);
  return ctx.db.prepare(`SELECT p.*, u.name lead_pm_name, b.code branch_code, b.name branch_name, b.currency FROM projects p JOIN branches b ON b.id = p.branch_id
    LEFT JOIN users u ON u.id = p.lead_pm_id WHERE p.branch_id = ? AND p.status = 'live' ORDER BY p.number`).all(ctx.branch.id);
}

function roll(rows) {
  const t = { jobs: 0, contract: 0, claimed: 0, actual: 0, forecast: 0, earned: 0, wip: 0, underclaimed: 0, unearned: 0, forecast_profit: 0, profit_to_date: 0, open_vo: 0, open_vo_n: 0, tender_margin_sum: 0, tender_n: 0 };
  for (const r of rows) { const w = r.wip; t.jobs++; t.contract += w.contract_total; t.claimed += w.claimed; t.actual += w.cost.actual; t.forecast += w.cost.forecast; t.earned += w.earned; t.wip += w.wip; t.underclaimed += w.underclaimed; t.unearned += w.unearned; t.forecast_profit += w.forecast_profit; t.profit_to_date += w.profit_to_date; t.open_vo += w.open_vo_amt; t.open_vo_n += w.open_vo_n; if (r.tender_margin_pct != null) { t.tender_margin_sum += r.tender_margin_pct; t.tender_n++; } }
  t.forecast_margin_pct = t.contract ? t.forecast_profit / t.contract : null;
  t.margin_to_date_pct = t.earned ? t.profit_to_date / t.earned : null;
  t.avg_job_margin_pct = rows.length ? rows.reduce((a, r) => a + (r.wip.forecast_margin_pct || 0), 0) / rows.length : null;
  t.avg_tender_margin_pct = t.tender_n ? t.tender_margin_sum / t.tender_n : null;
  t.pct_complete = t.forecast ? t.actual / t.forecast : 0;
  return t;
}

module.exports = (r) => {
  r.get('/api/meta/disciplines', (ctx) => { A.requireUser(ctx); return disciplinesOf(ctx); });

  // Everything, with WIP per project — the base for the three views.
  const load = (ctx) => { A.requireUser(ctx); if (!ctx.company) throw new HttpError(403, 'Choose a company first'); return scopeProjects(ctx).map(p => ({ ...p, wip: wipFor(ctx.db, p) })); };

  // 1. Performance by project manager
  r.get('/api/insights/by-pm', (ctx) => {
    const rows = load(ctx);
    const byPm = new Map();
    for (const p of rows) { const k = p.lead_pm_id || 0; if (!byPm.has(k)) byPm.set(k, { pm_id: k, pm_name: p.lead_pm_name || 'Unassigned', branch_code: p.branch_code, projects: [] }); byPm.get(k).projects.push(p); }
    const pms = [...byPm.values()].map(g => ({ ...g, totals: roll(g.projects), projects: g.projects.map(p => ({ id: p.id, number: p.number, name: p.name, discipline: p.discipline, branch_code: p.branch_code, contract: p.wip.contract_total, claimed: p.wip.claimed, actual: p.wip.cost.actual, forecast: p.wip.cost.forecast, forecast_margin_pct: p.wip.forecast_margin_pct, tender_margin_pct: p.tender_margin_pct, wip: p.wip.wip, open_vo_amt: p.wip.open_vo_amt, open_vo_n: p.wip.open_vo_n, pct_cost: p.wip.pct_cost })) }))
      .sort((a, b) => b.totals.contract - a.totals.contract);
    return { pms, totals: roll(rows) };
  });

  // 2. Performance by discipline (fire / mechanical / electrical / hydraulic), with per-branch split inside each
  r.get('/api/insights/by-discipline', (ctx) => {
    const rows = load(ctx);
    const known = disciplinesOf(ctx); const keys = known.map(d => d.key); const extra = [...new Set(rows.map(p => p.discipline).filter(d => d && !keys.includes(d)))];
    const out = [...known, ...extra.map(k => ({ key: k, label: k[0].toUpperCase() + k.slice(1) }))].map(({ key: d, label }) => { const ps = rows.filter(p => p.discipline === d); const byBranch = {}; ps.forEach(p => { (byBranch[p.branch_code] = byBranch[p.branch_code] || []).push(p); });
      return { discipline: d, label, totals: roll(ps), branches: Object.entries(byBranch).map(([code, bp]) => ({ branch_code: code, totals: roll(bp) })).sort((a, b) => b.totals.contract - a.totals.contract),
        projects: ps.map(p => ({ id: p.id, number: p.number, name: p.name, branch_code: p.branch_code, pm: p.lead_pm_name, contract: p.wip.contract_total, forecast_margin_pct: p.wip.forecast_margin_pct, tender_margin_pct: p.tender_margin_pct, wip: p.wip.wip })) }; }).filter(d => d.totals.jobs > 0);
    return { disciplines: out, totals: roll(rows) };
  });

  // 3. WIP schedule — per project, grouped by branch; the month-end accounting view
  r.get('/api/insights/wip', (ctx) => {
    const rows = load(ctx);
    const byBranch = {}; rows.forEach(p => { (byBranch[p.branch_code] = byBranch[p.branch_code] || { branch_code: p.branch_code, branch_name: p.branch_name, currency: p.currency, projects: [] }).projects.push(p); });
    const branches = Object.values(byBranch).map(b => ({ ...b, totals: roll(b.projects), projects: b.projects.map(p => ({ id: p.id, number: p.number, name: p.name, discipline: p.discipline, pm: p.lead_pm_name, ...p.wip, cost: undefined, actual: p.wip.cost.actual, forecast: p.wip.cost.forecast })) }))
      .sort((a, b) => b.totals.contract - a.totals.contract);
    return { branches, totals: roll(rows), as_at: new Date().toISOString().slice(0, 10), method: 'Percentage of completion on cost: earned revenue = contract value (incl. approved VOs) × actual cost ÷ forecast cost. WIP = earned − claimed. Positive = underclaimed (contract asset); negative = overclaimed / unearned revenue (contract liability).' };
  });

  r.patch('/api/projects/:id/discipline', A.requireBranch, (ctx) => {
    const p = A.loadProject(ctx, ctx.params.id); A.requireWrite(ctx, p);
    if (!disciplinesOf(ctx).some(d => d.key === ctx.body.discipline)) throw new HttpError(400, 'Invalid discipline');
    ctx.db.prepare('UPDATE projects SET discipline = ? WHERE id = ?').run(ctx.body.discipline, p.id);
    return { ok: true };
  });
};
module.exports.wipFor = wipFor;
