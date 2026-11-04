// RōSK — single-page front end (no build step). Hash routes, fetch API, plain DOM.
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
let ME = null; // { user, branches, current_branch, role }

// ---------- utils ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cur = () => (ME?.current_branch?.currency || 'AUD');
const money = (n, d = 0) => n == null ? '—' : new Intl.NumberFormat('en-AU', { style: 'currency', currency: cur(), maximumFractionDigits: d, minimumFractionDigits: d }).format(n);
const mK = (n) => n == null ? '—' : Math.abs(n) >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? '$' + Math.round(n / 1e3) + 'k' : money(n);
const pct = (x, d = 0) => x == null ? '—' : (x * 100).toFixed(d) + '%';
const dt = (s) => s ? new Date(s.length > 10 ? s.replace(' ', 'T') + 'Z' : s).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const signed = (n) => `<span class="${n < 0 ? 'neg' : n > 0 ? 'pos' : ''}">${n > 0 ? '+' : n < 0 ? '−' : ''}${money(Math.abs(n))}</span>`;
const vo = (n) => 'VO-' + String(n).padStart(3, '0');
const ROLE = { branch_manager: 'Branch Manager', pm: 'Project Manager', supervisor: 'Supervisor', estimator: 'Estimator', finance: 'Finance · read-only', group_admin: 'Director' };
const ROLE_PILL = { branch_manager: 'bad', pm: 'info', supervisor: 'ok', estimator: 'purple', finance: 'grey', group_admin: 'bad' };
const VO_PILL = { draft: 'grey', priced: 'grey', submitted: 'info', approved: 'ok', disputed: 'bad', rejected: 'bad' };
const CL_PILL = { draft: 'grey', internal_review: 'warn', approved: 'info', served: 'info', certified: 'ok' };
const CL_LABEL = { draft: 'Draft', internal_review: 'Awaiting BM approval', approved: 'Approved — ready to serve', served: 'Served', certified: 'Certified' };

function toast(msg, err = false) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : ''); clearTimeout(t._t); t._t = setTimeout(() => t.className = '', 3500); }

async function api(path, opts = {}) {
  const r = await fetch(path, { method: opts.method || 'GET', headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(data.error || r.statusText); e.status = r.status; e.data = data; throw e; }
  return data;
}

function modal(html, onMount) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  bg.addEventListener('click', e => { if (e.target === bg) bg.remove(); });
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  if (onMount) onMount(bg, close);
  return close;
}
const formVals = (form) => Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, v === '' ? null : v]));

const canWrite = () => ME && !['finance'].includes(ME.role);
const isBM = () => ME && ['branch_manager', 'group_admin'].includes(ME.role);
const isDirector = () => ME?.user?.is_group_admin;

// ---------- icons ----------
const I = {
  dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>',
  proj: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/></svg>',
  vo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M4 12h10M4 17h7"/><path d="M17 15l3 3 3-3"/></svg>',
  claim: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>',
  cog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></svg>',
  log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 4h16v12H4z"/><path d="M8 20h8M12 16v4"/></svg>',
};

// ---------- shell ----------
function shell(active, content) {
  const b = ME.current_branch; const group = !b; const platformOnly = ME.user.is_platform_admin && !ME.company;
  const nav = platformOnly ? [['#/platform', I.globe, 'All companies']] : group ? [
    ['#/group', I.globe, 'Company overview'], ['#/audit', I.log, 'Audit log'],
    ...(ME.user.is_platform_admin ? [['sep'], ['#/platform', I.globe, 'RōSK · all companies']] : []),
  ] : [
    ['#/dashboard', I.dash, 'Dashboard'], ['#/projects', I.proj, 'Projects'], ['#/variations', I.vo, 'Variations'], ['#/claims', I.claim, 'Progress claims'],
    ...(isBM() ? [['sep'], ['#/users', I.users, 'Users & permissions'], ['#/settings', I.cog, 'Branch settings'], ['#/audit', I.log, 'Audit log']] : []),
    ...(isDirector() ? [['#/group', I.globe, 'Company overview']] : []),
    ...(ME.user.is_platform_admin ? [['sep'], ['#/platform', I.globe, 'RōSK · all companies']] : []),
  ];
  app.innerHTML = `<div class="app">
    <nav class="side" aria-label="Main">
      <div class="brand"><div class="logo" aria-hidden="true">R</div><div><b>RōSK</b><small>${esc(ME.company?.name || 'Platform')}</small></div></div>
      ${platformOnly ? '' : `<button class="switch" id="switchBranch" aria-label="Switch branch"><span class="tag ${group ? 'or' : ''}">${group ? 'ALL' : esc(b.code)}</span><span style="flex:1">${group ? 'Company view' : esc(b.name)}<small>${ME.role ? esc(ROLE[ME.role] || ME.role) : ''} · Switch branch ▾</small></span></button>`}
      ${nav.map(n => n[0] === 'sep' ? '<div class="sep"></div>' : `<a class="nav ${active === n[0] ? 'on' : ''}" href="${n[0]}">${n[1]}${n[2]}</a>`).join('')}
      <div class="who">Signed in as<br><b>${esc(ME.user.name)}</b><br>${ME.user.is_platform_admin && ME.company ? `<button id="leaveCo">Leave ${esc(ME.company.short_name || 'company')}</button> · ` : ''}<button id="logout">Sign out</button></div>
    </nav>
    <main>${content}</main></div>`;
  $('#switchBranch')?.addEventListener('click', () => { location.hash = '#/branch'; });
  $('#leaveCo')?.addEventListener('click', async () => { await api('/api/auth/company', { method: 'POST', body: { company_id: null } }); ME = await api('/api/me'); location.hash = '#/platform'; });
  $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); ME = null; location.hash = '#/login'; };
}
const header = (eyebrow, title, sub, actions = '') => `<header class="ph"><div class="t"><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div><div class="actions">${actions}</div></header>`;
const kpi = (l, v, d, cls = '') => `<div class="card kpi"><div class="l">${l}</div><div class="v ${cls}">${v}</div><div class="d">${d || ''}</div></div>`;

// ---------- views ----------
async function viewLogin(err) {
  app.innerHTML = `<div class="login"><aside class="hero">
    <div class="brand" style="padding:0"><div class="logo" style="width:40px;height:40px;font-size:18px" aria-hidden="true">R</div><div><b style="font-size:20px;letter-spacing:.02em">RōSK</b><small>Project controls for contractors</small></div></div>
    <div style="max-width:420px;display:flex;flex-direction:column;gap:16px"><h1>One sign-in. Your branch. Your jobs.</h1>
      <p>Project controls for contractors: variations, progress claims, budget vs cost and who's allowed to see what — built for how fire, mechanical, electrical and hydraulic businesses actually run jobs.</p>
      <ul><li>Each company's data is fully isolated; within it, each branch is its own boundary</li><li>PMs and supervisors see only the jobs they've been granted</li><li>Every sign-in, branch switch and change is logged</li></ul></div>
    <div class="small" style="color:#8F9198">RōSK · Project controls for contractors · AU &amp; NZ</div></aside>
    <section class="panel"><form class="lbox" id="loginForm"><div><h2 style="font-size:18px">Sign in</h2><div class="sub">Microsoft 365 single sign-on will replace this in the pilot.</div></div>
      <label class="f">Work email<input class="in" name="email" type="email" autocomplete="username" required value="jayden.brown@premiersg.com.au"></label>
      <label class="f">Password<input class="in" name="password" type="password" autocomplete="current-password" required value="psg2026"></label>
      ${err ? `<div class="err">${esc(err)}</div>` : ''}
      <button class="btn p" type="submit">Sign in</button>
      <div class="small muted">Demo sign-ins (password <code>psg2026</code>): <b>admin@rosk.app</b> (RōSK platform) · director@premiersg.com.au (PSG directors) · jayden.brown@premiersg.com.au (PSG VIC Branch Manager) · wade.kneale@premiersg.com.au (PM) · marcus.delaney@harbourlinehydraulics.com.au (small customer)</div></form></section></div>`;
  $('#loginForm').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/auth/login', { method: 'POST', body: formVals(e.target) }); ME = await api('/api/me'); location.hash = ME.user.is_platform_admin && !ME.company ? '#/platform' : '#/branch'; } catch (er) { viewLogin(er.message); } };
}

async function viewBranch() {
  ME = await api('/api/me');
  if (ME.user.is_platform_admin && !ME.company) return viewPlatform();
  const mine = ME.branches.filter(b => b.role);
  if (mine.length === 1 && !isDirector() && !ME.current_branch) { await api('/api/auth/branch', { method: 'POST', body: { branch_id: mine[0].id } }); ME = await api('/api/me'); location.hash = '#/dashboard'; return; }
  let sel = ME.current_branch?.id ?? (mine[0]?.id ?? null);
  const render = () => {
    app.innerHTML = `<div class="login"><aside class="hero"><div class="brand" style="padding:0"><div class="logo" style="width:40px;height:40px;font-size:18px" aria-hidden="true">R</div><div><b style="font-size:20px;letter-spacing:.02em">RōSK</b><small>Project controls for contractors</small></div></div>
      <div style="max-width:420px;display:flex;flex-direction:column;gap:16px"><div class="eyebrow" style="color:#8F9198">${esc(ME.company?.name || '')}</div><h1>Choose your branch</h1><p>You can switch branch any time from the top-left menu without signing out. Your role can differ per branch.</p></div><div></div></aside>
      <section class="panel"><div class="lbox">
        <div style="display:flex;align-items:center;gap:10px"><span class="av">${esc(ME.user.initials)}</span><div><b>${esc(ME.user.name)}</b><div class="small muted">${esc(ME.user.email)}</div></div><button class="btn s" id="lo" style="margin-left:auto">Not you?</button></div>
        <div class="branches">${ME.branches.map(b => `<button class="br ${b.role ? '' : 'dis'} ${sel === b.id ? 'on' : ''}" data-id="${b.id}" ${b.role ? '' : 'disabled'} aria-pressed="${sel === b.id}"><span class="tg">${esc(b.code)}</span><span><b>${esc(b.name)}</b><small>${b.role ? esc(b.offices || '') + ' · ' + esc(ROLE[b.role] || b.role) : 'No access — ask that Branch Manager'}</small></span></button>`).join('')}
          ${isDirector() ? `<button class="br ${sel === null ? 'on' : ''}" data-id="group" aria-pressed="${sel === null}"><span class="tg" style="background:var(--orange)">ALL</span><span><b>Company view</b><small>Directors, CEO &amp; CFO · read-only roll-up</small></span></button>` : ''}</div>
        <button class="btn p" id="go">Continue →</button></div></section></div>`;
    app.querySelectorAll('.br:not(.dis)').forEach(b => b.onclick = () => { sel = b.dataset.id === 'group' ? null : Number(b.dataset.id); render(); });
    $('#go').onclick = async () => { try { await api('/api/auth/branch', { method: 'POST', body: { branch_id: sel } }); ME = await api('/api/me'); location.hash = sel === null ? '#/group' : '#/dashboard'; } catch (e) { toast(e.message, true); } };
    $('#lo').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); ME = null; location.hash = '#/login'; };
  };
  render();
}

async function viewDashboard() {
  const d = await api('/api/dashboard'); const t = d.totals;
  const marginCls = t.forecast_margin_pct == null ? '' : t.forecast_margin_pct < 0.1 ? 'bad' : t.forecast_margin_pct < 0.14 ? 'warn' : '';
  shell('#/dashboard', header(`${esc(ME.current_branch.name)} · ${d.projects.length} live job${d.projects.length === 1 ? '' : 's'}${isBM() ? '' : ' you have access to'}`, 'Dashboard', `Live roll-up of ${isBM() ? 'the branch' : 'your jobs'}. Cost figures will sync from Sage; editable per job for now.`,
    canWrite() && ME.role !== 'supervisor' ? `<a class="btn p" href="#/projects/new">+ New project</a>` : '') +
    `<div class="kpis">${kpi('Contract value', mK(t.contract), 'incl. approved VOs')}${kpi('Claimed to date', mK(t.claimed), t.contract ? pct(t.claimed / t.contract) + ' of contract' : '')}${kpi('Cost to date', mK(t.cost), 'actuals · forecast ' + mK(t.forecast))}${kpi('Forecast margin', pct(t.forecast_margin_pct, 1), 'on forecast cost', marginCls)}${kpi('Open variations', mK(t.open_vo), t.open_vo_n + ' submitted / priced')}</div>
    <div class="row"><section class="card col2"><div class="ch"><h2>Jobs</h2><a href="#/projects">All projects →</a></div><div class="tw"><table><thead><tr><th>Job</th><th>Lead PM</th><th class="n">Contract</th><th class="n">Claimed</th><th class="n">Cost</th><th class="n">Fcst margin</th><th class="n">Open VOs</th><th style="width:130px">Claimed</th></tr></thead><tbody>
      ${d.projects.map(p => { const s = p.summary; return `<tr class="click" data-href="#/projects/${p.id}"><td><b>${esc(p.number)}</b><br><span class="small muted">${esc(p.name)}</span></td><td>${esc(p.lead_pm_name || '—')}</td><td class="n">${mK(s.contract_total)}</td><td class="n">${mK(s.claimed)}</td><td class="n">${mK(s.cost.actual)}</td><td class="n ${s.forecast_margin_pct != null && s.tender_margin_pct != null && s.forecast_margin_pct < s.tender_margin_pct - 0.005 ? 'neg' : ''}">${pct(s.forecast_margin_pct, 1)}${s.tender_margin_pct != null ? `<br><span class="small muted">tender ${pct(s.tender_margin_pct, 1)}</span>` : ''}</td><td class="n">${s.open_vo_n ? mK(s.open_vo_amt) + ` <span class="small muted">(${s.open_vo_n})</span>` : '—'}</td><td><div class="bar"><i style="width:${Math.min(100, s.claimed_pct * 100)}%"></i></div></td></tr>`; }).join('') || '<tr><td colspan="8" class="empty">No jobs granted to you yet — ask your Branch Manager.</td></tr>'}</tbody></table></div></section>
    <aside class="col1"><section class="card"><div class="ch"><h2>Needs attention</h2></div><div class="feed">${d.attention.map(a => `<a href="${esc(a.link || '#/dashboard')}"><span class="pill ${a.severity === 'high' ? 'bad' : a.severity === 'warn' ? 'warn' : 'info'}">${esc(a.tag)}</span><span><span class="small muted">${esc(a.project_number)}</span> · ${esc(a.text)}</span></a>`).join('') || '<div class="empty">Nothing outstanding</div>'}</div></section></aside></div>`);
  bindRows();
}
function bindRows() { app.querySelectorAll('tr[data-href]').forEach(tr => tr.onclick = (e) => { if (e.target.closest('button,a,input,select')) return; location.hash = tr.dataset.href; }); }

async function viewProjects() {
  const ps = await api('/api/projects');
  shell('#/projects', header(esc(ME.current_branch.name), 'Projects', `${ps.length} job${ps.length === 1 ? '' : 's'} visible to you`, canWrite() && ME.role !== 'supervisor' ? `<a class="btn p" href="#/projects/new">+ New project</a>` : '') +
    `<section class="card"><div class="tw"><table><thead><tr><th>Job</th><th>Client / head contractor</th><th>Lead PM</th><th>Your access</th><th class="n">Contract</th><th class="n">Claimed</th><th class="n">Fcst margin</th><th>PC date</th><th>Status</th></tr></thead><tbody>
    ${ps.map(p => `<tr class="click" data-href="#/projects/${p.id}"><td><b>${esc(p.number)}</b><br><span class="small muted">${esc(p.name)}</span></td><td>${esc(p.client || '—')}<br><span class="small muted">${esc(p.head_contractor || '')}</span></td><td>${esc(p.lead_pm_name || '—')}</td><td><span class="pill ${p.access_level === 'lead' ? 'bad' : p.access_level === 'member' ? 'info' : 'grey'}">${p.access_level === 'lead' ? (isBM() ? 'Branch' : 'Lead PM') : p.access_level === 'member' ? 'Team member' : 'Read-only'}</span></td><td class="n">${mK(p.summary.contract_total)}</td><td class="n">${pct(p.summary.claimed_pct)}</td><td class="n">${pct(p.summary.forecast_margin_pct, 1)}</td><td>${dt(p.pc_date)}</td><td><span class="pill ${p.status === 'live' ? 'ok' : 'grey'}">${esc(p.status)}</span></td></tr>`).join('') || '<tr><td colspan="9" class="empty">No projects visible.</td></tr>'}</tbody></table></div></section>`);
  bindRows();
}

async function viewProjectNew() {
  const users = await api('/api/branch/users');
  shell('#/projects', header(esc(ME.current_branch.name), 'New project', 'Creates the job in this branch. The lead PM is granted access automatically.') +
    `<form class="card pad form" id="pf" style="max-width:860px">
      <label>Job number<input class="in" name="number" required placeholder="${esc(ME.current_branch.job_prefix || '')}-26-0471"></label><label>Project name<input class="in" name="name" required></label>
      <label>Client<input class="in" name="client"></label><label>Head contractor<input class="in" name="head_contractor"></label>
      <label>Lead PM<select class="in" name="lead_pm_id">${users.filter(u => ['pm', 'branch_manager'].includes(u.role)).map(u => `<option value="${u.id}" ${u.id === ME.user.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
      <label>Contract value (ex GST)<input class="in" name="contract_value" type="number" step="1" min="0" required></label>
      <label>Retention %<input class="in" name="retention_pct" type="number" step="0.01" value="0.05"></label><label>Retention cap % of contract<input class="in" name="retention_cap_pct" type="number" step="0.01" value="0.05"></label>
      <label>Claim serve-by day of month<input class="in" name="claim_day" type="number" min="1" max="28" value="5"></label><label>Tender margin %<input class="in" name="tender_margin_pct" type="number" step="0.001" placeholder="0.15"></label>
      <label>Start date<input class="in" name="start_date" type="date"></label><label>Practical completion<input class="in" name="pc_date" type="date"></label>
      <div class="full actions"><button class="btn p" type="submit">Create project</button><a class="btn" href="#/projects">Cancel</a></div></form>`);
  $('#pf').onsubmit = async (e) => { e.preventDefault(); try { const p = await api('/api/projects', { method: 'POST', body: formVals(e.target) }); toast('Project created'); location.hash = `#/projects/${p.id}`; } catch (er) { toast(er.message, true); } };
}

async function viewProject(id, tab = 'overview') {
  const p = await api(`/api/projects/${id}`); const s = p.summary;
  const write = canWrite() && p.access_level !== 'readonly';
  const marginCls = s.forecast_margin_pct != null && s.tender_margin_pct != null && s.forecast_margin_pct < s.tender_margin_pct - 0.005 ? 'warn' : '';
  const tabs = [['overview', 'Overview'], ['costs', 'Budget & cost'], ['sov', 'Schedule of values'], ['team', 'Team & access']].map(([k, l]) => `<a class="btn ${tab === k ? 'p' : ''}" href="#/projects/${p.id}/${k}">${l}</a>`).join('');
  let body = '';
  if (tab === 'overview') {
    const totalRow = p.cost_codes.reduce((t, c) => ({ budget: t.budget + c.budget, committed: t.committed + c.committed, actual: t.actual + c.actual, forecast: t.forecast + c.forecast }), { budget: 0, committed: 0, actual: 0, forecast: 0 });
    body = `<div class="kpis">${kpi('Contract value', mK(s.contract_total), `incl. ${s.approved_vo_n} approved VO${s.approved_vo_n === 1 ? '' : 's'} (${mK(s.approved_vo)})`)}${kpi('Claimed to date', mK(s.claimed), `${pct(s.claimed_pct)} · ${s.certified_claims} claim${s.certified_claims === 1 ? '' : 's'} certified`)}${kpi('Cost to date', mK(s.cost.actual), 'forecast ' + mK(s.cost.forecast))}${kpi('Forecast margin', pct(s.forecast_margin_pct, 1), s.tender_margin_pct != null ? `tender ${pct(s.tender_margin_pct, 1)} · ${s.forecast_margin_pct >= s.tender_margin_pct ? '▲' : '▼'} ${Math.abs((s.forecast_margin_pct - s.tender_margin_pct) * 100).toFixed(1)} pts` : '', marginCls)}${kpi('Open variations', mK(s.open_vo_amt), `${s.open_vo_n} submitted · ${s.disputed_vo_n} disputed`)}</div>
    <div class="row"><section class="card col2"><div class="ch"><h2>Budget vs cost by cost code</h2><a href="#/projects/${p.id}/costs">Edit →</a></div><div class="tw"><table><thead><tr><th>Cost code</th><th class="n">Budget</th><th class="n">Committed</th><th class="n">Actual</th><th class="n">Forecast</th><th class="n">Var.</th><th style="width:130px">Spent</th></tr></thead><tbody>
      ${p.cost_codes.map(c => `<tr><td>${esc(c.code)} ${esc(c.name)}</td><td class="n">${money(c.budget)}</td><td class="n">${c.committed ? money(c.committed) : '—'}</td><td class="n">${money(c.actual)}</td><td class="n">${money(c.forecast)}</td><td class="n">${signed(c.budget - c.forecast)}</td><td><div class="bar"><i style="width:${c.forecast ? Math.min(100, c.actual / c.forecast * 100) : 0}%"></i></div></td></tr>`).join('')}
      <tr class="tot"><td>Total</td><td class="n">${money(totalRow.budget)}</td><td class="n">${money(totalRow.committed)}</td><td class="n">${money(totalRow.actual)}</td><td class="n">${money(totalRow.forecast)}</td><td class="n">${signed(totalRow.budget - totalRow.forecast)}</td><td></td></tr></tbody></table></div></section>
    <aside class="col1"><section class="card"><div class="ch"><h2>Needs attention</h2></div><div class="feed">${p.attention.map(a => `<a href="${esc(a.link || '#')}" ><span class="pill ${a.severity === 'high' ? 'bad' : a.severity === 'warn' ? 'warn' : 'info'}">${esc(a.tag)}</span><span>${esc(a.text)} ${write ? `<button class="btn s" data-resolve="${a.id}" style="margin-left:6px">Resolve</button>` : ''}</span></a>`).join('') || '<div class="empty">Nothing outstanding</div>'}</div></section>
      <section class="card pad stack"><div style="display:flex;justify-content:space-between;align-items:center"><h2 style="font-size:15px">Programme</h2>${write ? `<button class="btn s" id="editProg">Update</button>` : ''}</div>${p.programme.map(st => `<div><div style="display:flex;justify-content:space-between;font-size:13px"><span>${esc(st.name)}</span><span class="${st.pct_complete >= 100 ? 'pos' : ''}">${st.pct_complete >= 100 ? 'Complete' : st.pct_complete === 0 ? '<span class="muted">Not started</span>' : Math.round(st.pct_complete) + '%'}</span></div><div class="bar" style="margin-top:4px"><i class="${st.pct_complete >= 100 ? 'ok' : ''}" style="width:${st.pct_complete}%"></i></div></div>`).join('') || '<div class="muted small">No programme stages yet.</div>'}</section>
      <section class="card pad grid2"><div class="muted">Client</div><div>${esc(p.client || '—')}</div><div class="muted">Head contractor</div><div>${esc(p.head_contractor || '—')}</div><div class="muted">Start</div><div>${dt(p.start_date)}</div><div class="muted">Practical completion</div><div>${dt(p.pc_date)}</div><div class="muted">Retention</div><div>${pct(p.retention_pct)} capped at ${pct(p.retention_cap_pct)}</div><div class="muted">Claims served by</div><div>${p.claim_day}${['th', 'st', 'nd', 'rd'][p.claim_day % 10 > 3 || (p.claim_day > 10 && p.claim_day < 14) ? 0 : p.claim_day % 10]} of the month</div></section></aside></div>`;
  } else if (tab === 'costs') {
    body = `<section class="card"><div class="ch"><h2>Budget vs cost by cost code</h2><span class="small muted">Actuals will be synced from Sage; type figures here for now.</span></div><div class="tw"><table id="ccT"><thead><tr><th>Code</th><th>Name</th><th class="n">Budget</th><th class="n">Committed</th><th class="n">Actual</th><th class="n">Forecast</th><th class="n">Variance</th></tr></thead><tbody>
      ${p.cost_codes.map(c => `<tr><td><input class="ed" style="text-align:left;width:60px" value="${esc(c.code)}" data-f="code" ${write ? '' : 'disabled'}></td><td><input class="ed" style="text-align:left;width:240px" value="${esc(c.name)}" data-f="name" ${write ? '' : 'disabled'}></td><td class="n"><input class="ed" type="number" value="${c.budget}" data-f="budget" ${write ? '' : 'disabled'}></td><td class="n"><input class="ed" type="number" value="${c.committed}" data-f="committed" ${write ? '' : 'disabled'}></td><td class="n"><input class="ed" type="number" value="${c.actual}" data-f="actual" ${write ? '' : 'disabled'}></td><td class="n"><input class="ed" type="number" value="${c.forecast}" data-f="forecast" ${write ? '' : 'disabled'}></td><td class="n">${signed(c.budget - c.forecast)}</td></tr>`).join('')}</tbody></table></div>
      ${write ? `<div class="pad actions"><button class="btn" id="addCC">+ Add cost code</button><button class="btn p" id="saveCC">Save</button></div>` : ''}</section>`;
  } else if (tab === 'sov') {
    const total = p.sov.reduce((t, i) => t + i.amount, 0);
    body = `<section class="card"><div class="ch"><h2>Schedule of values (base contract)</h2><span class="small muted">Must total the contract value ${money(p.contract_value)}. Approved variations are added to claims automatically.</span></div><div class="tw"><table id="sovT"><thead><tr><th>Code</th><th>Description</th><th class="n">Amount</th></tr></thead><tbody>
      ${p.sov.map(i => `<tr data-id="${i.id}"><td><input class="ed" style="text-align:left;width:60px" value="${esc(i.code)}" data-f="code" ${write ? '' : 'disabled'}></td><td><input class="ed" style="text-align:left;width:360px" value="${esc(i.description)}" data-f="description" ${write ? '' : 'disabled'}></td><td class="n"><input class="ed" type="number" value="${i.amount}" data-f="amount" ${write ? '' : 'disabled'}></td></tr>`).join('')}
      <tr class="tot"><td colspan="2">Total <span class="small muted" id="sovDiff">${Math.abs(total - p.contract_value) > 0.5 ? `(${signed(total - p.contract_value)} vs contract)` : '✓ matches contract'}</span></td><td class="n" id="sovTot">${money(total)}</td></tr></tbody></table></div>
      ${write ? `<div class="pad actions"><button class="btn" id="addSov">+ Add line</button><button class="btn p" id="saveSov">Save</button></div>` : ''}</section>`;
  } else if (tab === 'team') {
    body = `<section class="card" style="max-width:860px"><div class="ch"><h2>Who can see this job</h2>${isBM() ? `<button class="btn s p" id="grant">+ Grant access</button>` : ''}</div><div class="tw"><table><thead><tr><th>Person</th><th>Access</th><th>Granted</th>${isBM() ? '<th></th>' : ''}</tr></thead><tbody>
      ${p.team.map(t => `<tr><td><span class="av" style="margin-right:8px">${esc(t.initials)}</span>${esc(t.name)}</td><td><span class="pill ${t.level === 'lead' ? 'bad' : t.level === 'member' ? 'info' : 'grey'}">${t.level === 'lead' ? 'Lead PM' : t.level === 'member' ? 'Team member' : 'Read-only'}</span></td><td class="small muted">${esc(t.granted_by_name || '—')} · ${dt(t.granted_at)}</td>${isBM() ? `<td><button class="btn s danger" data-revoke="${t.user_id}">Revoke</button></td>` : ''}</tr>`).join('')}</tbody></table></div>
      <div class="pad small muted">Branch Managers and Finance see every job in the branch without a grant. Supervisors and PMs see only the jobs listed against them.</div></section>`;
  }
  shell('#/projects', header(`Project ${esc(p.number)} · ${esc(ME.current_branch.code)}`, esc(p.name), `${p.head_contractor ? 'Head contractor: ' + esc(p.head_contractor) + ' · ' : ''}PM: ${esc(p.lead_pm_name || '—')} · PC ${dt(p.pc_date)}${p.access_level === 'readonly' ? ' · <span class="pill grey">read-only</span>' : ''}`,
    `<a class="btn" href="#/variations?project_id=${p.id}">Variations</a><a class="btn" href="#/claims?project_id=${p.id}">Claims</a>${write ? `<button class="btn p" id="newVo">+ New variation</button>` : ''}`) + `<div class="actions">${tabs}</div>` + body);
  bindRows();
  $('#newVo')?.addEventListener('click', () => voForm(p.id, null, () => viewProject(id, tab)));
  app.querySelectorAll('[data-resolve]').forEach(b => b.onclick = async (e) => { e.preventDefault(); await api(`/api/projects/${p.id}/attention/${b.dataset.resolve}/resolve`, { method: 'POST' }); viewProject(id, tab); });
  $('#editProg')?.addEventListener('click', () => modal(`<h2>Programme stages</h2><div class="stack" id="pg">${p.programme.map(st => `<div style="display:flex;gap:8px"><input class="in" style="flex:1" value="${esc(st.name)}"><input class="in" type="number" min="0" max="100" style="width:90px" value="${st.pct_complete}"></div>`).join('')}</div><div class="actions"><button class="btn" id="addSt">+ Stage</button><span style="flex:1"></span><button class="btn" data-close>Cancel</button><button class="btn p" id="saveSt">Save</button></div>`, (m, close) => {
    $('#addSt', m).onclick = () => $('#pg', m).insertAdjacentHTML('beforeend', '<div style="display:flex;gap:8px"><input class="in" style="flex:1" placeholder="Stage"><input class="in" type="number" min="0" max="100" style="width:90px" value="0"></div>');
    $('#saveSt', m).onclick = async () => { const programme = [...$('#pg', m).children].map(d => ({ name: d.children[0].value, pct_complete: +d.children[1].value })).filter(x => x.name); await api(`/api/projects/${p.id}/programme`, { method: 'PUT', body: { programme } }); close(); viewProject(id, tab); };
  }));
  const rowsOf = (tid) => [...app.querySelectorAll(`#${tid} tbody tr:not(.tot)`)].map(tr => { const o = { id: tr.dataset.id ? +tr.dataset.id : undefined }; tr.querySelectorAll('[data-f]').forEach(i => o[i.dataset.f] = i.type === 'number' ? +i.value : i.value); return o; }).filter(o => o.code || o.name || o.description);
  $('#saveCC')?.addEventListener('click', async () => { try { await api(`/api/projects/${p.id}/cost-codes`, { method: 'PUT', body: { cost_codes: rowsOf('ccT') } }); toast('Saved'); viewProject(id, tab); } catch (e) { toast(e.message, true); } });
  $('#addCC')?.addEventListener('click', () => $('#ccT tbody').insertAdjacentHTML('beforeend', `<tr><td><input class="ed" style="text-align:left;width:60px" data-f="code"></td><td><input class="ed" style="text-align:left;width:240px" data-f="name"></td><td class="n"><input class="ed" type="number" value="0" data-f="budget"></td><td class="n"><input class="ed" type="number" value="0" data-f="committed"></td><td class="n"><input class="ed" type="number" value="0" data-f="actual"></td><td class="n"><input class="ed" type="number" value="0" data-f="forecast"></td><td></td></tr>`));
  $('#saveSov')?.addEventListener('click', async () => { try { await api(`/api/projects/${p.id}/sov`, { method: 'PUT', body: { sov: rowsOf('sovT') } }); toast('Saved'); viewProject(id, tab); } catch (e) { toast(e.message, true); } });
  $('#addSov')?.addEventListener('click', () => $('#sovT tbody tr.tot').insertAdjacentHTML('beforebegin', `<tr><td><input class="ed" style="text-align:left;width:60px" data-f="code"></td><td><input class="ed" style="text-align:left;width:360px" data-f="description"></td><td class="n"><input class="ed" type="number" value="0" data-f="amount"></td></tr>`));
  $('#sovT')?.addEventListener('input', () => { const t = rowsOf('sovT').reduce((a, r) => a + (+r.amount || 0), 0); $('#sovTot').textContent = money(t); $('#sovDiff').innerHTML = Math.abs(t - p.contract_value) > 0.5 ? `(${signed(t - p.contract_value)} vs contract)` : '✓ matches contract'; });
  $('#grant')?.addEventListener('click', async () => { const users = await api('/api/branch/users'); modal(`<h2>Grant access to ${esc(p.number)}</h2><form class="form" id="gf"><label class="full">Person<select class="in" name="user_id">${users.filter(u => !['branch_manager', 'finance'].includes(u.role)).map(u => `<option value="${u.id}">${esc(u.name)} — ${esc(ROLE[u.role])}</option>`).join('')}</select></label><label class="full">Level<select class="in" name="level"><option value="member">Team member — can edit</option><option value="lead">Lead PM — becomes the job's PM</option><option value="readonly">Read-only</option></select></label><div class="full actions"><button class="btn p" type="submit">Grant</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, (m, close) => { $('#gf', m).onsubmit = async (e) => { e.preventDefault(); try { await api(`/api/projects/${p.id}/access`, { method: 'POST', body: formVals(e.target) }); close(); toast('Access granted'); viewProject(id, tab); } catch (er) { toast(er.message, true); } }; }); });
  app.querySelectorAll('[data-revoke]').forEach(b => b.onclick = async () => { if (!confirm('Revoke this person\'s access to the job?')) return; await api(`/api/projects/${p.id}/access/${b.dataset.revoke}`, { method: 'DELETE' }); viewProject(id, tab); });
}

// ---------- variations ----------
async function voForm(projectId, v, done) {
  const meta = await api('/api/meta/variations'); const users = await api('/api/branch/users');
  const f = (k, d = '') => esc(v?.[k] ?? d);
  modal(`<h2>${v ? esc(v.label) + ' — edit' : 'New variation'}</h2><form class="form" id="vf">
    <label class="full">Title<input class="in" name="title" required value="${f('title')}"></label>
    <label>Source<select class="in" name="source">${meta.sources.map(s => `<option ${v?.source === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
    <label>Discipline<select class="in" name="discipline">${meta.disciplines.map(s => `<option ${v?.discipline === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
    <label>Client reference (SI / RFI / NOD)<input class="in" name="client_ref" value="${f('client_ref')}"></label>
    <label>Owner<select class="in" name="owner_id">${users.map(u => `<option value="${u.id}" ${(v?.owner_id ?? ME.user.id) === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
    <label>Labour hours<input class="in" name="labour_hours" type="number" step="0.5" value="${f('labour_hours', 0)}"></label><label>Labour $<input class="in" name="labour_amt" type="number" value="${f('labour_amt', 0)}"></label>
    <label>Materials $<input class="in" name="materials_amt" type="number" value="${f('materials_amt', 0)}"></label><label>Sub / plant $<input class="in" name="sub_plant_amt" type="number" value="${f('sub_plant_amt', 0)}"></label>
    <label>Prelims &amp; margin $<input class="in" name="prelims_margin_amt" type="number" value="${f('prelims_margin_amt', 0)}"></label><label>Cost to date $ (Sage)<input class="in" name="cost_to_date" type="number" value="${f('cost_to_date', 0)}"></label>
    <label>Raised<input class="in" name="raised_at" type="date" value="${f('raised_at', new Date().toISOString().slice(0, 10))}"></label><label>% work done<input class="in" name="pct_done" type="number" min="0" max="100" value="${f('pct_done', 0)}"></label>
    <label class="full">Notes<textarea class="in" name="notes">${f('notes')}</textarea></label>
    <div class="full actions"><button class="btn p" type="submit">${v ? 'Save' : 'Create'}</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, (m, close) => {
    $('#vf', m).onsubmit = async (e) => { e.preventDefault(); const body = formVals(e.target); try { if (v) await api(`/api/variations/${v.id}`, { method: 'PATCH', body }); else await api(`/api/projects/${projectId}/variations`, { method: 'POST', body }); close(); toast(v ? 'Saved' : 'Variation raised'); done(); } catch (er) { toast(er.message, true); } };
  });
}

async function viewVariations(q) {
  const params = new URLSearchParams(); if (q.project_id) params.set('project_id', q.project_id); if (q.status) params.set('status', q.status); if (q.unclaimed) params.set('unclaimed', '1');
  const [{ variations: list, totals: t }, projects] = await Promise.all([api('/api/variations?' + params), api('/api/projects')]);
  const proj = q.project_id ? projects.find(p => p.id === +q.project_id) : null;
  const sel = q.sel ? list.find(v => v.id === +q.sel) : null;
  const filtered = list.filter(v => (!q.disc || v.discipline === q.disc) && (!q.search || (v.title + ' ' + v.label + ' ' + (v.client_ref || '')).toLowerCase().includes(q.search.toLowerCase())));
  shell('#/variations', header(proj ? `Project ${esc(proj.number)} · ${esc(proj.name)}` : esc(ME.current_branch.name), 'Variations register', proj ? '' : 'Across every job you can see', (canWrite() ? `<button class="btn p" id="newVo">+ New variation</button>` : '')) +
    `<div class="kpis">${kpi('Approved', `<span class="pos">+${mK(t.approved)}</span>`, t.approved_n + ' variations')}${kpi('Submitted, awaiting', mK(t.submitted), `${t.submitted_n} variations · avg ${t.avg_days_out} days out`)}${kpi('Disputed / rejected', `<span class="neg">${mK(t.disputed)}</span>`, `${t.disputed_n} disputed · ${t.rejected_n} rejected`)}${kpi('Work done, not yet priced', mK(t.unpriced), `${t.unpriced_n} draft · cost to date`, 'warn')}</div>
    <form class="filters" id="vfilt"><label class="f" style="flex:1 1 200px">Search<input class="in" name="search" type="search" placeholder="VO number, title, SI/RFI…" value="${esc(q.search || '')}"></label>
      <label class="f">Project<select class="in" name="project_id"><option value="">All</option>${projects.map(p => `<option value="${p.id}" ${+q.project_id === p.id ? 'selected' : ''}>${esc(p.number)}</option>`).join('')}</select></label>
      <label class="f">Status<select class="in" name="status"><option value="">All</option>${Object.keys(VO_PILL).map(s => `<option ${q.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label class="f">Discipline<select class="in" name="disc"><option value="">All</option>${['Wet fire', 'Dry fire', 'Design', 'Mechanical', 'Electrical'].map(s => `<option ${q.disc === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <label class="f" style="flex-direction:row;align-items:center;gap:8px;height:38px;font-size:13px;color:var(--ink)"><input type="checkbox" name="unclaimed" ${q.unclaimed ? 'checked' : ''}> Unclaimed only</label></form>
    <section class="card"><div class="tw"><table><thead><tr><th>VO</th>${proj ? '' : '<th>Job</th>'}<th>Title</th><th>Source</th><th>Disc.</th><th>Status</th><th class="n">Submitted</th><th class="n">Approved</th><th class="n">Cost</th><th class="n">Days out</th><th>Claimed in</th><th>Owner</th></tr></thead><tbody>
      ${filtered.map(v => `<tr class="click ${sel?.id === v.id ? 'sel' : ''}" data-href="#/variations?${new URLSearchParams({ ...q, sel: v.id })}"><td><b>${v.label}</b></td>${proj ? '' : `<td class="small">${esc(v.project_number)}</td>`}<td>${esc(v.title)}</td><td>${esc(v.source || '')}</td><td>${esc((v.discipline || '').replace(' fire', ''))}</td><td><span class="pill ${VO_PILL[v.status]}">${v.status}${v.status === 'submitted' && v.days_out > ME.current_branch.vo_response_days ? ' · overdue' : ''}</span></td><td class="n">${v.submitted_amt ? money(v.submitted_amt) : '—'}</td><td class="n">${v.approved_amt != null ? money(v.approved_amt) : '—'}</td><td class="n">${money(v.cost_to_date)}</td><td class="n ${v.days_out > ME.current_branch.vo_response_days ? 'neg' : ''}"><b>${v.days_out ?? '—'}</b></td><td>${v.first_claim_no ? 'Claim #' + v.first_claim_no : '<span class="muted">—</span>'}</td><td>${esc(v.owner_initials || '')}</td></tr>`).join('') || `<tr><td colspan="12" class="empty">No variations match.</td></tr>`}</tbody></table></div>
    <div class="pad small muted">Showing ${filtered.length} of ${list.length}</div></section>
    <div id="voDetail"></div>`);
  bindRows();
  $('#vfilt').oninput = $('#vfilt').onchange = () => { const v = formVals($('#vfilt')); const nq = {}; Object.entries(v).forEach(([k, val]) => { if (val) nq[k] = val; }); if (v.unclaimed) nq.unclaimed = '1'; location.hash = '#/variations?' + new URLSearchParams(nq); };
  $('#newVo')?.addEventListener('click', () => { if (projects.length === 1 || proj) voForm(proj ? proj.id : projects[0].id, null, () => viewVariations(q)); else modal(`<h2>New variation — which job?</h2><div class="stack">${projects.filter(p => p.access_level !== 'readonly').map(p => `<button class="br" data-p="${p.id}"><span><b>${esc(p.number)}</b><small>${esc(p.name)}</small></span></button>`).join('')}</div>`, (m, close) => m.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { close(); voForm(+b.dataset.p, null, () => viewVariations(q)); })); });
  if (sel) renderVoDetail(sel.id, q);
}

async function renderVoDetail(id, q) {
  const v = await api(`/api/variations/${id}`);
  const steps = ['draft', 'priced', 'submitted', v.status === 'rejected' ? 'rejected' : v.status === 'disputed' ? 'disputed' : 'approved', 'claimed'];
  const idx = v.claims.some(c => c.this_claim > 0) ? 4 : ['draft', 'priced', 'submitted', 'approved', 'disputed', 'rejected'].indexOf(v.status) >= 3 ? 3 : ['draft', 'priced', 'submitted'].indexOf(v.status);
  const stepLbl = { draft: `Raised ${dt(v.raised_at)}`, priced: 'Priced', submitted: v.submitted_at ? `Submitted ${dt(v.submitted_at)}` : 'Submitted', approved: v.approved_at ? `Approved ${dt(v.approved_at)}` : 'Client approval', disputed: 'Disputed', rejected: 'Rejected', claimed: v.claims.length ? 'Claimed #' + v.claims.map(c => c.number).join(', #') : 'Claimed' };
  const write = canWrite();
  const tr = v.allowed_transitions;
  const btn = (to, label, cls = '') => tr.includes(to) && write ? `<button class="btn ${cls}" data-to="${to}">${label}</button>` : '';
  $('#voDetail').innerHTML = `<section class="card accent row" style="padding:18px 20px"><div class="col2 stack">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span class="eyebrow">Selected</span><h2 style="font-size:16px">${v.label} · ${esc(v.title)}</h2><span class="pill ${VO_PILL[v.status]}">${v.status}</span></div>
    <div class="steps">${steps.map((s, i) => `<span class="step ${i < idx ? 'done' : i === idx ? 'now' : ''}"><i>${i < idx ? '✓' : i + 1}</i>${stepLbl[s]}</span>`).join('')}</div>
    <p style="margin:0;font-size:13px;line-height:1.5;white-space:pre-line">${esc([v.client_ref ? 'Ref ' + v.client_ref : '', v.source, v.discipline, v.owner_name ? 'Owner ' + v.owner_name : ''].filter(Boolean).join(' · '))}${v.notes ? '\n' + esc(v.notes) : ''}</p>
    <div class="actions">${write && !['approved', 'rejected'].includes(v.status) ? `<button class="btn" id="editVo">Edit / price</button>` : ''}${btn('priced', 'Mark priced')}${btn('submitted', 'Submit to client', 'p')}${btn('approved', 'Record approval', 'p')}${btn('disputed', 'Mark disputed')}${btn('rejected', 'Record rejection', 'danger')}${btn('draft', 'Back to draft')}${write && v.status === 'draft' ? `<button class="btn danger" id="delVo">Delete</button>` : ''}${write && ['approved'].includes(v.status) ? `<button class="btn" id="costVo">Update cost to date</button>` : ''}</div>
    ${v.history.length ? `<details><summary class="small muted" style="cursor:pointer">History (${v.history.length})</summary><div class="hist" style="margin-top:8px">${v.history.map(h => `<div><b>${esc(h.action.replace('variation.', ''))}</b> · ${esc(h.user_name || 'system')} · ${dt(h.at)}${h.detail ? ` <span class="muted small">${esc(JSON.stringify(JSON.parse(h.detail)).slice(0, 120))}</span>` : ''}</div>`).join('')}</div></details>` : ''}</div>
    <div class="grid2" style="flex:0 1 320px"><div class="muted">Labour</div><div style="text-align:right">${v.labour_hours || 0} hrs · ${money(v.labour_amt)}</div><div class="muted">Materials</div><div style="text-align:right">${money(v.materials_amt)}</div><div class="muted">Sub / plant</div><div style="text-align:right">${money(v.sub_plant_amt)}</div><div class="muted">Prelims &amp; margin</div><div style="text-align:right">${money(v.prelims_margin_amt)}</div>
      <div style="font-weight:700;border-top:1px solid var(--line);padding-top:8px">${v.status === 'approved' ? 'Approved' : v.submitted_at ? 'Submitted' : 'Priced'}</div><div style="text-align:right;font-weight:700;border-top:1px solid var(--line);padding-top:8px">${money(v.status === 'approved' ? v.approved_amt : v.submitted_amt || v.priced_total)}</div>
      ${v.status === 'approved' && v.approved_amt !== v.submitted_amt ? `<div class="muted">Submitted</div><div style="text-align:right" class="muted">${money(v.submitted_amt)} (${signed(v.approved_amt - v.submitted_amt)})</div>` : ''}
      <div class="muted">Cost to date</div><div style="text-align:right">${money(v.cost_to_date)} · ${v.pct_done || 0}% done</div>
      ${v.cost_to_date && (v.approved_amt || v.submitted_amt) ? `<div class="muted">Margin on VO</div><div style="text-align:right ${((v.approved_amt ?? v.submitted_amt) - v.cost_to_date) < 0 ? 'neg' : ''}">${pct(((v.approved_amt ?? v.submitted_amt) - v.cost_to_date / ((v.pct_done || 100) / 100)) / (v.approved_amt ?? v.submitted_amt), 1)} <span class="small muted">at completion</span></div>` : ''}</div></section>`;
  $('#editVo')?.addEventListener('click', () => voForm(v.project.id, v, () => viewVariations(q)));
  $('#delVo')?.addEventListener('click', async () => { if (!confirm(`Delete ${v.label}?`)) return; await api(`/api/variations/${v.id}`, { method: 'DELETE' }); delete q.sel; location.hash = '#/variations?' + new URLSearchParams(q); });
  $('#costVo')?.addEventListener('click', () => modal(`<h2>${v.label} — cost to date</h2><form class="form" id="cf"><label>Cost to date $<input class="in" name="cost_to_date" type="number" value="${v.cost_to_date}"></label><label>% done<input class="in" name="pct_done" type="number" min="0" max="100" value="${v.pct_done}"></label><div class="full actions"><button class="btn p">Save</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, (m, close) => $('#cf', m).onsubmit = async (e) => { e.preventDefault(); await api(`/api/variations/${v.id}`, { method: 'PATCH', body: formVals(e.target) }); close(); renderVoDetail(id, q); }));
  $('#voDetail').querySelectorAll('[data-to]').forEach(b => b.onclick = () => {
    const to = b.dataset.to; const needAmt = ['submitted', 'approved'].includes(to);
    modal(`<h2>${v.label} → ${to}</h2><form class="form" id="tf">${needAmt ? `<label>${to === 'approved' ? 'Approved amount' : 'Submitted amount'} $<input class="in" name="amount" type="number" step="0.01" value="${to === 'approved' ? v.submitted_amt : (v.submitted_amt || v.priced_total)}"></label><label>Date<input class="in" name="date" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>` : ''}<label class="full">Note (added to the VO log)<textarea class="in" name="note" placeholder="${to === 'disputed' ? 'What the client disputes and our position' : to === 'rejected' ? 'Reason given' : ''}"></textarea></label>
      ${to === 'submitted' && (v.submitted_amt || v.priced_total) > ME.current_branch.vo_approval_threshold && !isBM() ? `<div class="full err">Over ${money(ME.current_branch.vo_approval_threshold)} — a Branch Manager must submit this one.</div>` : ''}
      <div class="full actions"><button class="btn p">Confirm</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, (m, close) => $('#tf', m).onsubmit = async (e) => { e.preventDefault(); try { await api(`/api/variations/${v.id}/transition`, { method: 'POST', body: { to, ...formVals(e.target) } }); close(); toast(`${v.label} ${to}`); viewVariations(q); } catch (er) { toast(er.message, true); } });
  });
}

// ---------- claims ----------
async function viewClaims(q) {
  const [claims, projects] = await Promise.all([api('/api/claims' + (q.project_id ? `?project_id=${q.project_id}` : '')), api('/api/projects')]);
  const proj = q.project_id ? projects.find(p => p.id === +q.project_id) : null;
  shell('#/claims', header(proj ? `Project ${esc(proj.number)}` : esc(ME.current_branch.name), 'Progress claims', proj ? esc(proj.name) : 'Across every job you can see', canWrite() && ME.role !== 'supervisor' ? `<button class="btn p" id="newClaim">+ Start claim</button>` : '') +
    `<section class="card"><div class="tw"><table><thead><tr><th>Claim</th><th>Job</th><th>Period end</th><th>Status</th><th class="n">This period</th><th>Serve by</th><th>Served</th><th class="n">Certified</th></tr></thead><tbody>
    ${claims.map(c => `<tr class="click" data-href="#/projects/${c.project_id}/claims/${c.id}"><td><b>#${c.number}</b></td><td>${esc(c.project_number)} <span class="small muted">${esc(c.project_name)}</span></td><td>${dt(c.period_end)}</td><td><span class="pill ${CL_PILL[c.status]}">${CL_LABEL[c.status]}</span></td><td class="n">${money(c.this_period)}</td><td class="${c.status !== 'served' && c.status !== 'certified' && c.serve_by < new Date().toISOString().slice(0, 10) ? 'neg' : ''}">${dt(c.serve_by)}</td><td>${dt(c.served_at)}</td><td class="n">${c.certified_amt != null ? money(c.certified_amt) : '—'}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">No claims yet.</td></tr>'}</tbody></table></div></section>`);
  bindRows();
  $('#newClaim')?.addEventListener('click', () => {
    const start = async (pid) => { const pe = new Date(); pe.setDate(0); modal(`<h2>Start a claim</h2><form class="form" id="nc"><label>Period ending<input class="in" name="period_end" type="date" value="${pe.toISOString().slice(0, 10)}"></label><label>Serve by (blank = project default)<input class="in" name="serve_by" type="date"></label><div class="full actions"><button class="btn p">Create draft</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, (m, close) => $('#nc', m).onsubmit = async (e) => { e.preventDefault(); try { const c = await api(`/api/projects/${pid}/claims`, { method: 'POST', body: formVals(e.target) }); close(); location.hash = `#/projects/${pid}/claims/${c.id}`; } catch (er) { toast(er.message, true); } }); };
    if (proj) start(proj.id); else modal(`<h2>Which job?</h2><div class="stack">${projects.filter(p => p.access_level !== 'readonly').map(p => `<button class="br" data-p="${p.id}"><span><b>${esc(p.number)}</b><small>${esc(p.name)}</small></span></button>`).join('')}</div>`, (m, close) => m.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { close(); start(+b.dataset.p); }));
  });
}

async function viewClaim(pid, cid) {
  const c = await api(`/api/claims/${cid}`); const s = c.summary; const p = c.project;
  const editable = canWrite() && ['draft', 'internal_review'].includes(c.status);
  const tr = c.allowed_transitions;
  const row = (l) => { const cum = l.prev_claimed + l.this_claim; const pc = l.contract_amt ? cum / l.contract_amt * 100 : 0; return `<tr data-k="${l.kind}" data-r="${l.ref_id}"><td>${esc(l.description)}</td><td class="n">${money(l.contract_amt)}</td><td class="n">${money(l.prev_claimed)}</td><td class="n"><input class="ed pct" type="number" step="0.1" min="0" max="100" value="${pc.toFixed(1)}" data-f="pct" ${editable ? '' : 'disabled'} aria-label="${esc(l.description)} percent complete"></td><td class="n"><input class="ed" type="number" step="0.01" value="${l.this_claim}" data-f="this_claim" ${editable ? '' : 'disabled'} aria-label="${esc(l.description)} this claim"></td><td class="n">${money(cum)}</td><td class="n ${l.contract_amt - cum < -0.005 ? 'neg' : ''}">${money(l.contract_amt - cum)}</td></tr>`; };
  const base = c.lines.filter(l => l.kind === 'base'); const vos = c.lines.filter(l => l.kind === 'variation');
  const sumc = (arr, f) => arr.reduce((t, l) => t + f(l), 0);
  const act = (to, label, cls = '') => tr.includes(to) && canWrite() ? `<button class="btn ${cls}" data-to="${to}">${label}</button>` : '';
  shell('#/claims', header(`Project ${esc(p.number)} · ${esc(p.name)} · <a href="#/claims?project_id=${p.id}">All claims</a>`, `Progress claim #${c.number} <span class="pill ${CL_PILL[c.status]}" style="vertical-align:middle;margin-left:8px">${CL_LABEL[c.status]}</span>`,
    `Period ending ${dt(c.period_end)} · Serve by <b class="${c.serve_by < new Date().toISOString().slice(0, 10) && !c.served_at ? 'neg' : ''}">${dt(c.serve_by)}</b>${c.served_at ? ` · Served ${dt(c.served_at)} · Payment due ${dt(c.payment_due)}` : ''}${c.certified_at ? ` · Certified ${dt(c.certified_at)} ${money(c.certified_amt)}` : ''}`,
    `${editable ? `<button class="btn" id="saveLines">Save draft</button>` : ''}<button class="btn" id="pdf">Preview claim</button>${act('internal_review', 'Submit for BM approval', 'p')}${act('approved', 'Approve claim', 'p')}${act('served', 'Mark as served', 'p')}${act('certified', 'Record certification', 'p')}${act('draft', 'Reopen draft')}${canWrite() && c.status === 'draft' ? `<button class="btn danger" id="delClaim">Delete</button>` : ''}`) +
    `<div class="row"><section class="card" style="flex:3 1 620px;min-width:0"><div class="ch"><h2>Schedule of values</h2><span class="small muted">${editable ? 'Enter either <b>% complete</b> (cumulative) or <b>this claim $</b> — the other updates. Save, then submit.' : 'Locked — reopen to draft to edit.'}</span></div><div class="tw"><table id="lines"><thead><tr><th>Item</th><th class="n">Contract $</th><th class="n">Prev. claimed</th><th class="n">% complete</th><th class="n">This claim</th><th class="n">Cumulative</th><th class="n">To go</th></tr></thead><tbody>
      <tr class="sec"><td colspan="7">A · Base contract</td></tr>${base.map(row).join('')}<tr class="tot"><td>Base contract subtotal</td><td class="n">${money(sumc(base, l => l.contract_amt))}</td><td class="n">${money(sumc(base, l => l.prev_claimed))}</td><td class="n">—</td><td class="n" id="baseThis">${money(s.base_this)}</td><td class="n">${money(sumc(base, l => l.prev_claimed + l.this_claim))}</td><td class="n">${money(sumc(base, l => l.contract_amt - l.prev_claimed - l.this_claim))}</td></tr>
      <tr class="sec"><td colspan="7">B · Approved variations <span style="font-weight:400" class="muted">(pulled from the register — only approved VOs appear)</span></td></tr>${vos.map(row).join('') || '<tr><td colspan="7" class="muted small">No approved variations on this job yet.</td></tr>'}<tr class="tot"><td>Variations subtotal (${vos.length} approved)</td><td class="n">${money(s.vo_total)}</td><td class="n">${money(sumc(vos, l => l.prev_claimed))}</td><td class="n">—</td><td class="n">${money(s.vo_this)}</td><td class="n">${money(sumc(vos, l => l.prev_claimed + l.this_claim))}</td><td class="n">${money(sumc(vos, l => l.contract_amt - l.prev_claimed - l.this_claim))}</td></tr></tbody></table></div></section>
    <aside class="col1"><section class="card pad"><h2 style="font-size:15px;margin-bottom:8px">Claim summary</h2>
      <div class="tot-row"><span class="l">Work this period (A + B)</span><span>${money(s.this_period)}</span></div><div class="tot-row"><span class="l">Cumulative work to date</span><span>${money(s.cumulative)} <span class="small muted">(${pct(s.pct_complete)})</span></span></div>
      <div class="tot-row"><span class="l">Less retention ${pct(p.retention_pct)} (cap ${pct(p.retention_cap_pct)}) held to date</span><span class="neg">−${money(s.retention_held)}</span></div><div class="tot-row"><span class="l">Less previously certified</span><span class="neg">−${money(s.prev_certified)}</span></div>
      <div class="tot-row big"><span>Amount claimed (ex GST)</span><span>${money(s.amount_ex_gst)}</span></div><div class="tot-row"><span class="l">GST ${pct(ME.current_branch.gst_rate)}</span><span>${money(s.gst)}</span></div><div class="tot-row" style="font-weight:700"><span>Total incl. GST</span><span>${money(s.amount_inc_gst)}</span></div>
      ${c.certified_amt != null ? `<div class="tot-row" style="border-top:1px solid var(--line);margin-top:6px;padding-top:8px"><span class="l">Certified (ex GST)</span><span class="${c.certified_amt < s.amount_ex_gst - 0.5 ? 'neg' : 'pos'}">${money(c.certified_amt)}${c.certified_amt < s.amount_ex_gst - 0.5 ? ` <span class="small">(−${money(s.amount_ex_gst - c.certified_amt)})</span>` : ''}</span></div>` : ''}</section>
      <section class="card pad stack"><h2 style="font-size:15px">Checks before serving</h2>${c.checks.map(k => `<div class="check"><span class="pill ${k.level === 'ok' ? 'ok' : k.level === 'fail' ? 'bad' : 'warn'}">${k.level === 'ok' ? 'OK' : k.level === 'fail' ? 'Fix' : 'Check'}</span><span>${esc(k.text)}</span></div>`).join('')}</section>
      <section class="card pad stack"><h2 style="font-size:15px">Approval &amp; history</h2><div class="hist">
        <div><b>Drafted</b> · ${esc(c.drafted_by_name || '—')} · ${dt(c.created_at)}</div>
        <div><b>Branch Manager approval</b> · ${c.approved_by_name ? esc(c.approved_by_name) : ['draft'].includes(c.status) ? '<span class="muted">not yet submitted</span>' : c.status === 'internal_review' ? '<span class="pill warn">pending</span>' : '—'}</div>
        <div><b>Served to client</b> · ${c.served_at ? dt(c.served_at) + ' · payment due ' + dt(c.payment_due) : '<span class="muted">generates PDF + email, logs date served</span>'}</div>
        <div><b>Payment schedule / certification</b> · ${c.certified_at ? dt(c.certified_at) + ' · ' + money(c.certified_amt) : '<span class="muted">record certified amount; shortfalls raise an attention item</span>'}</div>
        <div><b>Post to Sage</b> · <span class="muted">invoice raised on certification (integration to come)</span></div>
        ${c.history.filter(h => !['claim.lines'].includes(h.action)).map(h => `<div class="small muted">${esc(h.action.replace('claim.', ''))} · ${esc(h.user_name || '')} · ${dt(h.at)}</div>`).join('')}</div>
        ${c.notes ? `<div class="small" style="white-space:pre-line;border-top:1px solid var(--line);padding-top:8px">${esc(c.notes)}</div>` : ''}</section></aside></div>`);
  // live % <-> $ linking
  const tbl = $('#lines');
  tbl?.addEventListener('input', (e) => {
    const inp = e.target; const trow = inp.closest('tr'); if (!trow?.dataset.k) return;
    const line = c.lines.find(l => l.kind === trow.dataset.k && l.ref_id === +trow.dataset.r);
    const pctI = trow.querySelector('[data-f=pct]'), amtI = trow.querySelector('[data-f=this_claim]');
    if (inp === pctI) amtI.value = (Math.min(100, Math.max(0, +pctI.value)) / 100 * line.contract_amt - line.prev_claimed).toFixed(2);
    else pctI.value = line.contract_amt ? ((line.prev_claimed + (+amtI.value)) / line.contract_amt * 100).toFixed(1) : 0;
    const cum = line.prev_claimed + (+amtI.value); trow.children[5].textContent = money(cum); trow.children[6].textContent = money(line.contract_amt - cum); trow.children[6].className = 'n ' + (line.contract_amt - cum < -0.005 ? 'neg' : '');
  });
  const collect = () => [...tbl.querySelectorAll('tr[data-k]')].map(trw => ({ kind: trw.dataset.k, ref_id: +trw.dataset.r, this_claim: +trw.querySelector('[data-f=this_claim]').value }));
  const save = async () => { if (editable) await api(`/api/claims/${c.id}/lines`, { method: 'PUT', body: { lines: collect() } }); };
  $('#saveLines')?.addEventListener('click', async () => { try { await save(); toast('Draft saved'); viewClaim(pid, cid); } catch (e) { toast(e.message, true); } });
  $('#delClaim')?.addEventListener('click', async () => { if (!confirm('Delete this draft claim?')) return; await api(`/api/claims/${c.id}`, { method: 'DELETE' }); location.hash = `#/claims?project_id=${p.id}`; });
  $('#pdf').onclick = () => { const w = window.open('', '_blank'); w.document.write(claimPrintHtml(c)); w.document.close(); };
  app.querySelectorAll('[data-to]').forEach(b => b.onclick = () => {
    const to = b.dataset.to;
    modal(`<h2>Claim #${c.number} → ${CL_LABEL[to]}</h2><form class="form" id="tf">${to === 'certified' ? `<label>Certified amount (ex GST)<input class="in" name="certified_amt" type="number" step="0.01" value="${s.amount_ex_gst}" required></label>` : ''}<label>Date<input class="in" name="date" type="date" value="${new Date().toISOString().slice(0, 10)}"></label><label class="full">Note<textarea class="in" name="note"></textarea></label>
      ${to === 'internal_review' && c.checks.some(k => k.level === 'fail') ? `<div class="full err">Failing checks must be fixed first.</div>` : ''}<div class="full actions"><button class="btn p">Confirm</button><button class="btn" type="button" data-close>Cancel</button></div></form>`,
      (m, close) => $('#tf', m).onsubmit = async (e) => { e.preventDefault(); try { await save(); await api(`/api/claims/${c.id}/transition`, { method: 'POST', body: { to, ...formVals(e.target) } }); close(); toast(`Claim #${c.number}: ${CL_LABEL[to]}`); viewClaim(pid, cid); } catch (er) { toast(er.message + (er.data?.checks ? ' — ' + er.data.checks.map(k => k.text).join('; ') : ''), true); } });
  });
}

function claimPrintHtml(c) {
  const s = c.summary; const b = ME.current_branch;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Payment claim ${esc(c.project.number)} #${c.number}</title><style>body{font-family:Inter,system-ui,sans-serif;font-size:12px;color:#111;margin:32px;max-width:900px}h1{font-size:20px;margin:0}table{border-collapse:collapse;width:100%;margin-top:16px}th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}td.n,th.n{text-align:right}.tot td{font-weight:700}.hd{display:flex;justify-content:space-between;align-items:flex-start}.box{border:1px solid #ccc;padding:10px 14px;margin-top:16px}.muted{color:#666}@media print{button{display:none}}</style></head><body>
  <div class="hd"><div><h1>Payment claim #${c.number}</h1><div class="muted">${esc(ME.company?.name || '')} — ${esc(b.name)} branch · prepared in RōSK</div></div><div style="text-align:right"><div><b>Project:</b> ${esc(c.project.number)} ${esc(c.project.name)}</div><div><b>To:</b> ${esc(c.project.head_contractor || c.project.client || '[Head contractor]')}</div><div><b>Period ending:</b> ${dt(c.period_end)}</div><div><b>Date served:</b> ${c.served_at ? dt(c.served_at) : '[on serving]'}</div></div></div>
  <div class="box">This is a payment claim made under the <i>Building and Construction Industry Security of Payment Act 2002 (Vic)</i> [confirm applicable Act / contract clause]. Reference date: ${dt(c.period_end)}.</div>
  <table><thead><tr><th>Item</th><th class="n">Contract</th><th class="n">Previously claimed</th><th class="n">This claim</th><th class="n">Cumulative</th><th class="n">%</th></tr></thead><tbody>
  ${c.lines.map(l => `<tr><td>${esc(l.description)}</td><td class="n">${money(l.contract_amt)}</td><td class="n">${money(l.prev_claimed)}</td><td class="n">${money(l.this_claim)}</td><td class="n">${money(l.prev_claimed + l.this_claim)}</td><td class="n">${l.contract_amt ? ((l.prev_claimed + l.this_claim) / l.contract_amt * 100).toFixed(0) : 0}%</td></tr>`).join('')}
  <tr class="tot"><td>Total work to date</td><td class="n">${money(s.contract_total)}</td><td class="n"></td><td class="n">${money(s.this_period)}</td><td class="n">${money(s.cumulative)}</td><td class="n">${pct(s.pct_complete)}</td></tr></tbody></table>
  <table style="max-width:420px;margin-left:auto"><tr><td>Cumulative work to date</td><td class="n">${money(s.cumulative)}</td></tr><tr><td>Less retention held (${pct(c.project.retention_pct)}, cap ${pct(c.project.retention_cap_pct)})</td><td class="n">−${money(s.retention_held)}</td></tr><tr><td>Less previously certified</td><td class="n">−${money(s.prev_certified)}</td></tr><tr class="tot"><td>Amount claimed (ex GST)</td><td class="n">${money(s.amount_ex_gst)}</td></tr><tr><td>GST ${pct(b.gst_rate)}</td><td class="n">${money(s.gst)}</td></tr><tr class="tot"><td>Total claimed incl. GST</td><td class="n">${money(s.amount_inc_gst)}</td></tr></table>
  <p class="muted" style="margin-top:24px">Statutory declaration and supporting documentation attached. Prepared by ${esc(c.drafted_by_name || '')}${c.approved_by_name ? ', approved by ' + esc(c.approved_by_name) : ''}.</p>
  <button onclick="print()" style="margin-top:16px;padding:8px 14px">Print / save as PDF</button></body></html>`;
}

// ---------- users & permissions ----------
async function viewUsers(q) {
  const users = await api('/api/branch/users'); const b = ME.current_branch;
  const selId = q.u ? +q.u : users.find(u => u.role === 'pm')?.id;
  const sel = users.find(u => u.id === selId);
  const access = sel && !sel.sees_all ? await api(`/api/branch/users/${sel.id}/access`) : [];
  const projects = await api('/api/projects');
  const tick = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#1E7F4F" stroke-width="3" role="img" aria-label="yes"><path d="M5 13l4 4L19 7"/></svg>';
  const dash = '<span style="color:#C4C9D1">—</span>';
  const M = [['See own jobs’ dashboard & costs', 1, 1, 1, 1, 1], ['See all branch jobs', 0, 0, 0, 1, 1], ['Timesheets, site diary, defects (to come)', 1, 1, 0, 1, 0], ['Raise & price a variation', 1, 1, 1, 1, 0], ['Submit variation to client', 0, 1, 1, 1, 0], [`Submit variation over ${money(b.vo_approval_threshold)}`, 0, 0, 0, 1, 0], ['Draft progress claim', 0, 1, 0, 1, 0], ['Approve claim', 0, 0, 0, 1, 0], ['Serve claim', 0, 1, 0, 1, 0], ['Record certification', 0, 0, 0, 1, 1], ['Grant / revoke job access, manage users', 0, 0, 0, 1, 0]];
  shell('#/users', header(`Administration · ${esc(b.name)}`, 'Users & permissions', 'Each person signs in with their own account and sees only the jobs granted to them. Checked on every request, not just the menu.', `<a class="btn" href="#/settings">Branch settings</a><button class="btn p" id="invite">+ Invite user</button>`) +
    `<div class="row"><section class="card" style="flex:1 1 380px;min-width:0"><div class="ch"><h2>People · ${esc(b.code)}</h2></div><div class="tw"><table><thead><tr><th>Name</th><th>Role</th><th class="c">Jobs</th><th>Status</th><th></th></tr></thead><tbody>
      ${users.map(u => `<tr class="click ${u.id === selId ? 'sel' : ''}" data-href="#/users?u=${u.id}"><td><div style="display:flex;align-items:center;gap:10px"><span class="av">${esc(u.initials)}</span><div>${esc(u.name)}<div class="small muted">${esc(u.email)}</div></div></div></td><td><span class="pill ${ROLE_PILL[u.role]}">${esc(ROLE[u.role])}</span>${u.is_group_admin ? ' <span class="pill bad">Director</span>' : ''}</td><td class="c">${u.sees_all ? `All (${u.total_jobs})` : u.job_count}</td><td>${u.active ? '<span class="pos">Active</span>' : '<span class="muted">Disabled</span>'}</td><td><button class="btn s" data-edit="${u.id}">Edit</button></td></tr>`).join('')}</tbody></table></div></section>
    ${sel ? `<section class="card accent" style="flex:1 1 460px;min-width:0"><div class="ch"><div style="display:flex;align-items:center;gap:12px"><span class="av" style="width:36px;height:36px;font-size:13px">${esc(sel.initials)}</span><div><h2>${esc(sel.name)} · ${esc(ROLE[sel.role])}</h2><div class="small muted">${sel.sees_all ? `Sees all ${sel.total_jobs} ${b.code} jobs by role.` : `Sees ${access.length} of ${sel.total_jobs} ${b.code} jobs.`}</div></div></div><button class="btn s" data-edit="${sel.id}">Change role</button></div>
      <div class="pad stack">${sel.sees_all ? '' : `<div style="display:flex;justify-content:space-between;align-items:center"><h3 style="font-size:13px">Job access</h3><button class="btn s" id="grantU">+ Grant job</button></div><div class="tw"><table><thead><tr><th>Job</th><th>Access</th><th>Granted</th><th></th></tr></thead><tbody>
        ${access.map(a => `<tr><td>${esc(a.number)} <span class="small muted">${esc(a.name)}</span></td><td><span class="pill ${a.level === 'lead' ? 'bad' : a.level === 'member' ? 'info' : 'grey'}">${a.level === 'lead' ? 'Lead PM' : a.level === 'member' ? 'Team member' : 'Read-only'}</span></td><td class="small muted">${esc(a.granted_by_name || '')} · ${dt(a.granted_at)}</td><td><button class="btn s danger" data-rv="${a.project_id}">Revoke</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted small">No jobs granted — this person sees nothing yet.</td></tr>'}</tbody></table></div>`}
      <h3 style="font-size:13px;margin-top:8px">What each role can do</h3><div class="tw"><table><thead><tr><th>Action</th><th class="c">Supervisor</th><th class="c">PM</th><th class="c">Estimator</th><th class="c">Branch Mgr</th><th class="c">Finance</th></tr></thead><tbody>${M.map(r => `<tr><td>${r[0]}</td>${r.slice(1).map(x => `<td class="c">${x ? tick : dash}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="small muted">Approval threshold and response periods are set in Branch settings. Every grant, revoke and role change is in the audit log.</div></div></section>` : ''}</div>`);
  bindRows();
  const editUser = (u) => modal(`<h2>${u ? esc(u.name) : 'Invite user'}</h2><form class="form" id="uf">${u ? '' : `<label>Full name<input class="in" name="name" required></label><label>Work email<input class="in" name="email" type="email" required placeholder="first.last@premiersg.com.au"></label>`}
    <label class="${u ? 'full' : ''}">Role in ${esc(b.code)}<select class="in" name="role">${Object.entries(ROLE).filter(([k]) => k !== 'group_admin').map(([k, v]) => `<option value="${k}" ${u?.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    ${u ? `<label>Reset password (optional)<input class="in" name="password" type="text" placeholder="leave blank to keep"></label><label style="flex-direction:row;align-items:center;gap:8px;margin-top:22px"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Account active</label>` : `<label>Temporary password (blank = generate)<input class="in" name="password"></label>`}
    <div class="full actions"><button class="btn p">${u ? 'Save' : 'Invite'}</button>${u && u.id !== ME.user.id ? `<button class="btn danger" type="button" id="rmU">Remove from branch</button>` : ''}<button class="btn" type="button" data-close>Cancel</button></div></form>`, (m, close) => {
    $('#uf', m).onsubmit = async (e) => { e.preventDefault(); const v = formVals(e.target); try { if (u) { await api(`/api/branch/users/${u.id}`, { method: 'PATCH', body: { role: v.role, password: v.password || undefined, active: !!e.target.active.checked } }); toast('Saved'); } else { const r = await api('/api/branch/users', { method: 'POST', body: v }); toast(r.temp_password ? `Invited — temporary password: ${r.temp_password}` : 'Invited'); } close(); viewUsers(q); } catch (er) { toast(er.message, true); } };
    $('#rmU', m)?.addEventListener('click', async () => { if (!confirm(`Remove ${u.name} from ${b.code}? Their job grants here are revoked.`)) return; await api(`/api/branch/users/${u.id}`, { method: 'DELETE' }); close(); location.hash = '#/users'; });
  });
  app.querySelectorAll('[data-edit]').forEach(bt => bt.onclick = (e) => { e.stopPropagation(); editUser(users.find(u => u.id === +bt.dataset.edit)); });
  $('#invite').onclick = () => editUser(null);
  $('#grantU')?.addEventListener('click', () => modal(`<h2>Grant ${esc(sel.name)} a job</h2><form class="form" id="gf"><label class="full">Job<select class="in" name="project_id">${projects.filter(p => !access.some(a => a.project_id === p.id)).map(p => `<option value="${p.id}">${esc(p.number)} — ${esc(p.name)}</option>`).join('')}</select></label><label class="full">Level<select class="in" name="level"><option value="member">Team member — can edit</option><option value="lead">Lead PM</option><option value="readonly">Read-only</option></select></label><div class="full actions"><button class="btn p">Grant</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, (m, close) => $('#gf', m).onsubmit = async (e) => { e.preventDefault(); const v = formVals(e.target); try { await api(`/api/projects/${v.project_id}/access`, { method: 'POST', body: { user_id: sel.id, level: v.level } }); close(); viewUsers(q); } catch (er) { toast(er.message, true); } }));
  app.querySelectorAll('[data-rv]').forEach(bt => bt.onclick = async () => { if (!confirm('Revoke access?')) return; await api(`/api/projects/${bt.dataset.rv}/access/${sel.id}`, { method: 'DELETE' }); viewUsers(q); });
}

async function viewSettings() {
  const b = await api('/api/branch');
  shell('#/settings', header(`Administration · ${esc(b.code)}`, 'Branch settings', 'Controls that differ per state. Group-wide items (Sage mapping, estimating templates) are set by directors.') +
    `<form class="card pad form" id="sf" style="max-width:760px"><label>Branch name<input class="in" name="name" value="${esc(b.name)}"></label><label>Offices<input class="in" name="offices" value="${esc(b.offices || '')}"></label><label>Job number prefix<input class="in" name="job_prefix" value="${esc(b.job_prefix || '')}"></label><label>Currency<input class="in" name="currency" value="${esc(b.currency)}"></label><label>GST rate<input class="in" name="gst_rate" type="number" step="0.01" value="${b.gst_rate}"></label><label>VO approval threshold (Branch Manager must submit above)<input class="in" name="vo_approval_threshold" type="number" value="${b.vo_approval_threshold}"></label><label>Client VO response period (days)<input class="in" name="vo_response_days" type="number" value="${b.vo_response_days}"></label><label>Payment schedule period (business days)<input class="in" name="claim_response_days" type="number" value="${b.claim_response_days}"></label><div class="full actions"><button class="btn p">Save</button></div></form>`);
  $('#sf').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/branch', { method: 'PATCH', body: formVals(e.target) }); ME = await api('/api/me'); toast('Saved'); } catch (er) { toast(er.message, true); } };
}

async function viewAudit() {
  const rows = await api('/api/audit?limit=200');
  shell('#/audit', header(ME.current_branch ? esc(ME.current_branch.name) : esc(ME.company?.name || 'Company'), 'Audit log', 'Every sign-in, branch switch, grant, approval and edit — who, when, and in which branch.') +
    `<section class="card"><div class="tw"><table><thead><tr><th>When</th><th>Who</th><th>Branch</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead><tbody>${rows.map(r => `<tr><td class="small">${esc(r.at)}</td><td>${esc(r.user_name || 'system')}</td><td>${esc(r.branch_code || '—')}</td><td><b>${esc(r.action)}</b></td><td class="small muted">${esc(r.entity || '')} ${r.entity_id || ''}</td><td class="small muted" style="white-space:normal;max-width:420px">${esc(r.detail || '')}</td></tr>`).join('')}</tbody></table></div></section>`);
}

async function viewGroup() {
  if (!isDirector()) { location.hash = '#/dashboard'; return; }
  const g = await api('/api/group/overview'); const t = g.group;
  const STATUS = { live: ['ok', 'Live'], onboarding: ['grey', 'To onboard'], launch_2027: ['warn', 'Launching'] };
  shell('#/group', header(`${esc(g.company.name)} · all branches`, 'Company overview', 'Live roll-up of every branch. Branch Managers only ever see their own row. ' + esc(g.note), `<button class="btn" id="addBranch">+ Add branch</button>`) +
    `<div class="kpis">${kpi('Live contract value', mK(t.contract), `across ${t.jobs} active jobs`)}${kpi('Claimed to date', mK(t.claimed), t.contract ? pct(t.claimed / t.contract) + ' of contract' : '')}${kpi('Forecast margin', pct(t.forecast_margin_pct, 1), 'on forecast cost')}${kpi('Open variations', mK(t.open_vo), t.open_vo_n + ' awaiting client')}${kpi('Claims awaiting approval', t.unapproved, 'with Branch Managers')}</div>
    <section class="card"><div class="ch"><h2>Branch performance</h2><span class="small muted">Click a branch to enter it with director permissions</span></div><div class="tw"><table><thead><tr><th>Branch</th><th>Offices</th><th>Branch Manager</th><th class="c">Users</th><th class="n">Active jobs</th><th class="n">Contract value</th><th class="n">Claimed</th><th class="n">Fcst margin</th><th class="n">Open VOs</th><th style="width:130px">Programme</th><th>Status</th></tr></thead><tbody>
    ${g.branches.map(b => `<tr class="click" data-branch="${b.id}"><td><span class="tag">${esc(b.code)}</span> <b>${esc(b.name)}</b></td><td class="small">${esc(b.offices || '')}</td><td>${esc(b.branch_managers.join(', ') || '—')}</td><td class="c">${b.users}</td><td class="n">${b.active_jobs}</td><td class="n">${b.active_jobs ? (b.currency !== 'AUD' ? b.currency + ' ' : '') + mK(b.totals.contract) : '—'}</td><td class="n">${b.active_jobs ? mK(b.totals.claimed) : '—'}</td><td class="n">${b.active_jobs ? pct(b.totals.forecast_margin_pct, 1) : '—'}</td><td class="n">${b.totals.open_vo_n ? mK(b.totals.open_vo) : '—'}</td><td><div class="bar"><i style="width:${b.programme_health}%"></i></div></td><td><span class="pill ${(STATUS[b.status] || ['grey'])[0]}">${(STATUS[b.status] || [0, b.status])[1]}</span></td></tr>`).join('')}</tbody></table></div></section>
    <div class="grid3"><section class="card pad stack"><h2 style="font-size:15px">What a branch controls</h2><ul style="margin:0;padding-left:18px;line-height:1.7;font-size:13px"><li>Its own users, roles and job grants</li><li>Job numbering prefix and cost-code set</li><li>Approval thresholds and response periods</li><li>Currency and GST</li></ul></section>
    <section class="card pad stack"><h2 style="font-size:15px">What the company sets once</h2><ul style="margin:0;padding-left:18px;line-height:1.7;font-size:13px"><li>Accounting system mapping (${esc(g.company.accounting || 'Sage, MYOB, Xero, Jobpac')}) per entity</li><li>Standard cost-code and schedule templates per trade</li><li>Margin and retention reporting rules</li><li>Director and finance accounts that span branches</li></ul></section>
    <section class="card pad stack"><h2 style="font-size:15px">Cross-branch access</h2><ul style="margin:0;padding-left:18px;line-height:1.7;font-size:13px"><li>A user can belong to several branches with a different role in each</li><li>Switching branch keeps you signed in; data and permissions change</li><li>Company view is read-only — changes are made inside a branch</li><li>The audit log records which branch every action was taken in</li></ul></section></div>`);
  app.querySelectorAll('tr[data-branch]').forEach(trw => trw.onclick = async () => { await api('/api/auth/branch', { method: 'POST', body: { branch_id: +trw.dataset.branch } }); ME = await api('/api/me'); location.hash = '#/dashboard'; });
  $('#addBranch').onclick = () => modal(`<h2>Add branch</h2><form class="form" id="bf"><label>Code<input class="in" name="code" required placeholder="WA"></label><label>Name<input class="in" name="name" required></label><label>Country<select class="in" name="country"><option>AU</option><option>NZ</option></select></label><label>Currency<input class="in" name="currency" value="AUD"></label><label>GST rate<input class="in" name="gst_rate" type="number" step="0.01" value="0.10"></label><label>Offices<input class="in" name="offices"></label><label class="full">First Branch Manager email (optional)<input class="in" name="bm_email" type="email"></label><label class="full">Their name<input class="in" name="bm_name"></label><div class="full actions"><button class="btn p">Create</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, (m, close) => $('#bf', m).onsubmit = async (e) => { e.preventDefault(); const v = formVals(e.target); try { const b = await api('/api/group/branches', { method: 'POST', body: v }); if (v.bm_email) { const r = await api(`/api/group/branches/${b.id}/members`, { method: 'POST', body: { email: v.bm_email, name: v.bm_name, role: 'branch_manager' } }); if (r.temp_password) toast(`Branch created. BM temp password: ${r.temp_password}`); } close(); viewGroup(); } catch (er) { toast(er.message, true); } });
}

// ---------- RōSK platform (all companies) ----------
async function viewPlatform() {
  if (!ME.user.is_platform_admin) { location.hash = '#/dashboard'; return; }
  const cos = await api('/api/platform/companies');
  const tot = cos.reduce((t, c) => ({ value: t.value + c.live_value, jobs: t.jobs + c.live_jobs, users: t.users + c.users }), { value: 0, jobs: 0, users: 0 });
  shell('#/platform', header('RōSK · platform', 'All companies', 'Every customer on RōSK. Each company is fully isolated — entering one gives you a director\'s view inside it.', `<button class="btn p" id="addCo">+ Onboard company</button>`) +
    `<div class="kpis">${kpi('Companies', cos.length, cos.filter(c => c.plan === 'enterprise').length + ' enterprise')}${kpi('Live contract value', mK(tot.value), 'across all customers')}${kpi('Live jobs', tot.jobs, '')}${kpi('Users', tot.users, 'active accounts')}</div>
    <section class="card"><div class="ch"><h2>Customers</h2><span class="small muted">Click a company to enter it</span></div><div class="tw"><table><thead><tr><th>Company</th><th>Trades</th><th>Plan</th><th>Accounting</th><th class="c">Branches</th><th class="c">Users</th><th class="n">Live jobs</th><th class="n">Live value</th><th>Last activity</th><th>Status</th></tr></thead><tbody>
    ${cos.map(c => `<tr class="click" data-co="${c.id}"><td><b>${esc(c.name)}</b><br><span class="small muted">${esc(c.short_name || '')} · ${esc(c.country)}</span></td><td>${esc(c.trades || '')}</td><td><span class="pill ${c.plan === 'enterprise' ? 'bad' : 'info'}">${esc(c.plan)}</span></td><td>${esc(c.accounting || '—')}</td><td class="c">${c.branches}</td><td class="c">${c.users}</td><td class="n">${c.live_jobs}</td><td class="n">${mK(c.live_value)}</td><td class="small muted">${dt(c.last_activity)}</td><td><span class="pill ${c.status === 'active' ? 'ok' : 'grey'}">${esc(c.status)}</span></td></tr>`).join('')}</tbody></table></div></section>
    <div class="grid3"><section class="card pad stack"><h2 style="font-size:15px">What a company gets</h2><ul style="margin:0;padding-left:18px;line-height:1.7;font-size:13px"><li>Its own branches, users, roles and job grants</li><li>Cost-code and schedule templates per trade</li><li>Accounting integration mapped to its own entities</li><li>Its own audit log — nothing shared between customers</li></ul></section>
    <section class="card pad stack"><h2 style="font-size:15px">Plans</h2><ul style="margin:0;padding-left:18px;line-height:1.7;font-size:13px"><li><b>Standard</b> — single branch, up to ~25 users</li><li><b>Enterprise</b> — multi-branch, multi-entity, SSO, company-wide roll-up</li><li>Pricing model to be confirmed (per user / per branch / per job value)</li></ul></section>
    <section class="card pad stack"><h2 style="font-size:15px">Platform controls</h2><ul style="margin:0;padding-left:18px;line-height:1.7;font-size:13px"><li>Onboard a company with its first branch and admin</li><li>Enter any company as a director for support</li><li>Every platform action is logged against the admin</li></ul></section></div>`);
  app.querySelectorAll('tr[data-co]').forEach(trw => trw.onclick = async () => { await api('/api/auth/company', { method: 'POST', body: { company_id: +trw.dataset.co } }); ME = await api('/api/me'); location.hash = '#/group'; });
  $('#addCo').onclick = () => modal(`<h2>Onboard a company</h2><form class="form" id="cf"><label class="full">Company name<input class="in" name="name" required></label><label>Short name<input class="in" name="short_name"></label><label>Trades<input class="in" name="trades" placeholder="Fire · Hydraulic"></label><label>Plan<select class="in" name="plan"><option value="standard">Standard</option><option value="enterprise">Enterprise</option><option value="pilot">Pilot</option></select></label><label>Country<select class="in" name="country"><option>AU</option><option>NZ</option></select></label><label>Accounting system<input class="in" name="accounting" placeholder="Xero / MYOB / Sage / Jobpac"></label><label>First branch code<input class="in" name="first_branch_code" placeholder="SYD"></label><label class="full">First branch name<input class="in" name="first_branch_name"></label><label>Admin email<input class="in" name="admin_email" type="email"></label><label>Admin name<input class="in" name="admin_name"></label><div class="full actions"><button class="btn p">Create</button><button class="btn" type="button" data-close>Cancel</button></div></form>`, (m, close) => $('#cf', m).onsubmit = async (e) => { e.preventDefault(); try { const r = await api('/api/platform/companies', { method: 'POST', body: formVals(e.target) }); toast(r.admin_temp_password ? `Created. Admin temp password: ${r.admin_temp_password}` : 'Created'); close(); viewPlatform(); } catch (er) { toast(er.message, true); } });
}

// ---------- router ----------
async function route() {
  const hash = location.hash || '#/dashboard';
  const [pathPart, qs] = hash.slice(1).split('?');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  const seg = pathPart.split('/').filter(Boolean);
  try {
    if (!ME) { try { ME = await api('/api/me'); } catch { ME = null; } }
    if (!ME) return viewLogin();
    if (seg[0] === 'login') return viewLogin();
    if (seg[0] === 'branch') return viewBranch();
    if (seg[0] === 'platform') return viewPlatform();
    if (ME.user.is_platform_admin && !ME.company) return viewPlatform();
    if (!ME.current_branch && !(ME.role === 'group_admin')) return viewBranch();
    if (!ME.current_branch) { if (seg[0] === 'audit') return viewAudit(); return viewGroup(); }
    switch (seg[0]) {
      case 'dashboard': return viewDashboard();
      case 'projects':
        if (seg[1] === 'new') return viewProjectNew();
        if (seg[1] && seg[2] === 'claims' && seg[3]) return viewClaim(seg[1], seg[3]);
        if (seg[1] && seg[2] === 'variations') { location.hash = `#/variations?project_id=${seg[1]}`; return; }
        if (seg[1]) return viewProject(seg[1], seg[2] || 'overview');
        return viewProjects();
      case 'variations': return viewVariations(q);
      case 'claims': return viewClaims(q);
      case 'users': return viewUsers(q);
      case 'settings': return viewSettings();
      case 'audit': return viewAudit();
      case 'group': return viewGroup();
      default: location.hash = '#/dashboard';
    }
  } catch (e) {
    if (e.status === 401) { ME = null; return viewLogin(); }
    if (e.status === 403 && /branch/i.test(e.message)) return viewBranch();
    app.innerHTML = `<div class="empty"><h2>${esc(e.message)}</h2><p><a href="#/dashboard">Back to dashboard</a></p></div>`;
  }
}
window.addEventListener('hashchange', route);
route();
