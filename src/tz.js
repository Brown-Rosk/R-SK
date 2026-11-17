'use strict';
// Branch-local time. Each branch is a place; "today" and "now" on timesheets and attendance mean that place's day,
// not the server's (Render runs in UTC — a Melbourne crew signing in at 6:45am is still "yesterday" in UTC).
const BY_CODE = { VIC: 'Australia/Melbourne', NSW: 'Australia/Sydney', ACT: 'Australia/Sydney', QLD: 'Australia/Brisbane', WA: 'Australia/Perth', SA: 'Australia/Adelaide', NT: 'Australia/Darwin', TAS: 'Australia/Hobart', NZ: 'Pacific/Auckland', SG: 'Asia/Singapore', JP: 'Asia/Tokyo', UAE: 'Asia/Dubai', AE: 'Asia/Dubai' };
const BY_COUNTRY = { AU: 'Australia/Sydney', NZ: 'Pacific/Auckland', SG: 'Asia/Singapore', JP: 'Asia/Tokyo', AE: 'Asia/Dubai', GB: 'Europe/London', US: 'America/New_York' };

function tzFor(branch) {
  if (!branch) return 'Australia/Sydney';
  if (branch.timezone) return branch.timezone;
  return BY_CODE[String(branch.code || '').toUpperCase()] || BY_COUNTRY[String(branch.country || '').toUpperCase()] || 'Australia/Sydney';
}

function parts(tz, at = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
  const o = {}; for (const p of f.formatToParts(at)) o[p.type] = p.value;
  if (o.hour === '24') o.hour = '00';
  return o;
}
function todayIn(tz, at) { const o = parts(tz, at); return `${o.year}-${o.month}-${o.day}`; }
function nowHMIn(tz, at) { const o = parts(tz, at); return `${o.hour}:${o.minute}`; }
function hourIn(tz, at) { return Number(parts(tz, at).hour); }

module.exports = { tzFor, todayIn, nowHMIn, hourIn };
