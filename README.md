# RōSK — Project Controls

Project controls for contractors (fire, mechanical, electrical, hydraulic): projects, budget vs cost, variations register, progress claims — multi-tenant, with **company → branch → job** partitioning and **per-PM job permissions** enforced on the server.

**Status:** working build for demonstration. Premier Services Group is seeded as the first customer (its VIC team is real; every other person, client and project is invented sample data). A second small customer, Harbourline Hydraulics, shows the product at single-branch scale.

**Demo sign-ins** (password `psg2026`): `admin@rosk.app` (RōSK platform, sees all companies) · `director@premiersg.com.au` (PSG company view) · `jayden.brown@premiersg.com.au` (PSG VIC Branch Manager, also WA) · `wade.kneale@premiersg.com.au` (PM) · `marcus.delaney@harbourlinehydraulics.com.au` (owner of the small customer).

## Run it

Requires Node 22.13 or later. No other dependencies — nothing to install.

```bash
node server.js            # starts on http://localhost:3000 and seeds sample data on first run
npm test                  # permission-boundary and workflow tests
npm run reset             # wipe the database and re-seed
PORT=8080 node server.js  # different port
PSG_DB=/path/to/psg.sqlite node server.js   # different database file (default: ./data/psg.sqlite)
```

### Sample sign-ins (password `psg2026` for all)

| Email | Role | What they see |
|---|---|---|
| jayden.brown@premiersg.com.au | Branch Manager (VIC) + Branch Manager (WA) | Every VIC job; empty WA branch; can switch between the two |
| wade.kneale@premiersg.com.au | Project Manager (VIC) | 4 of 5 VIC jobs (lead on 2, team member on 1, read-only on 1) |
| nik.borobokas@ / matt.manjiviona@ / lachlan.gillard@ | Project Managers (VIC) | Only their own jobs |
| nathan.kurzemnieks@premiersg.com.au | Supervisor (VIC) | 3 jobs; can raise and price VOs but not submit them or draft claims |
| finance@premiersg.com.au | Finance (VIC) | Every VIC job, read-only, except recording claim certification |
| director@premiersg.com.au | Group director | Group view across all branches; can enter any branch |

## How permissions work

0. **Company is the outer boundary.** Every branch, user, project and audit entry belongs to one company. A user's session can only ever see their own company; a RōSK platform admin can enter a company to act as a director there (logged).
1. **Branch is the hard boundary within a company.** Every project belongs to one branch. A session has one current branch; every query is filtered by it. Users can be members of several branches with a different role in each (e.g. VIC Branch Manager and WA rollout lead).
2. **Within a branch**, `branch_manager` and `finance` see every job. `pm`, `supervisor` and `estimator` see only jobs listed against them in `project_access` (levels: `lead`, `member`, `readonly`). A job the user cannot see returns **404**, not 403, so its existence isn't confirmed.
3. **Who can do what** is role-based on top of job access: supervisors can't submit VOs or draft claims; VOs over the branch threshold ($25k default) need a Branch Manager to submit; claims need Branch Manager approval before serving; finance records certification. See the matrix on the Users & permissions screen.
4. **Directors** (`is_group_admin`) see the group roll-up and can enter any branch.
5. **Everything is audited** — sign-ins, branch switches, grants, revokes, every workflow transition — with the branch it happened in.

## What's in this build

- Sign in → choose branch → dashboard (KPIs, jobs you can see, attention feed)
- Projects: overview, budget vs committed vs actual vs forecast by cost code, schedule of values, programme stages, team & access
- Variations register: draft → priced → submitted → approved / disputed / rejected, ageing against the branch response period, priced breakdown, cost to date, history
- Progress claims: schedule of values from the project + approved VOs, enter % or $, retention with cap, previously certified, GST, pre-serve checks, draft → BM approval → served → certified, shortfall detection, printable claim
- Users & permissions, branch settings, audit log
- Group overview for directors; add branches and appoint their first Branch Manager

### Added in v0.5
- **Insights** (directors, Branch Managers, Finance): performance by project manager, by discipline (fire / mechanical / electrical / hydraulic), and a **WIP schedule** — percentage-of-completion on cost, earned vs claimed, underclaimed (asset) vs unearned revenue (liability), CSV export.
- **Timesheets**: phone-friendly sign in / sign out per job, manual entries, weekly submit; supervisors/PMs approve; approved labour (with overtime and on-costs) flows into the job's labour cost code.
- **Wage rates** per state × trade × classification (base, OT multipliers, allowances, on-cost %). Seeded figures are **placeholders** — load the applicable EBA / award before payroll relies on them.
- **Attendance**: per job per day — crew expected, signed in, away, on another job.
- **Onboarding**: per-company welcome page (videos, uniform link, timesheet instructions, contacts, documents) on a public link with a printable **QR code**.
- **Toolbox talks**: supervisors record talks with attendees, hazards, actions and signed-sheet uploads.
- New **field** role for site staff (timesheets only).

## Not yet (next builds)

- Microsoft 365 single sign-on (the auth layer is isolated in `src/auth.js` so this is a swap, not a rewrite)
- Sage integration (actuals into cost codes, invoice on certification)
- Timesheets / site diary / defects & commissioning modules
- File attachments on VOs and claims (photos, SIs, RFIs)
- Email on serve; PDF generation server-side (currently browser print)
- NZ FX in the group roll-up

## Layout

```
server.js            entry point; mounts routes and static files
src/db.js            SQLite schema (node:sqlite, WAL mode)
src/http.js          tiny router / JSON / cookies / static on node:http
src/auth.js          passwords, sessions, branch context, permission helpers, audit
src/routes/          auth, projects (+dashboard), variations, claims, admin (+group, audit)
public/              single-page front end: index.html, app.js, styles.css — no build step
scripts/seed.js      sample data
test/                node:test suite
```

## Production notes

For a pilot beyond one machine: put it behind HTTPS (any reverse proxy), set a long random `PSG_DB` path on persistent storage, back up the SQLite file nightly (it's one file), and change the seeded passwords or move to SSO first. SQLite is fine for a branch; group-wide concurrent use would move to Postgres — the SQL is standard and the data layer is in one file.
