// Runs on a GitHub Actions schedule. Checks the current time in America/Toronto
// against data/schedule.json, and sends a real Web Push notification (via APNs,
// since iOS 16.4+) for anything due in the current run window — so it arrives
// even if the Discipline Engine app hasn't been opened today.
//
// Needs two repo secrets: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (already
// generated), and data/subscription.json committed once after the phone
// subscribes from Settings → "Set up push notifications".
'use strict';
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const ROOT = path.join(__dirname, '..');
const SCHEDULE_PATH = path.join(ROOT, 'data', 'schedule.json');
const SUB_PATH = path.join(ROOT, 'data', 'subscription.json');
const SENT_PATH = path.join(ROOT, 'data', 'sent.json');
// GitHub's scheduler is best-effort: runs often start 10-30+ min late and some
// are skipped entirely. A wide catch-up window means a late run still delivers
// the reminder instead of dropping it. Anything past LATE_AFTER is flagged.
const WINDOW_MINUTES = 45;
const LATE_AFTER = 10;
// Nudges are only useful on time; don't send them stale.
const NUDGE_WINDOW = 15;

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

function nowInToronto() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get('weekday')];
  const mins = (+get('hour')) * 60 + (+get('minute'));
  const dateKey = `${get('year')}-${get('month')}-${get('day')}`;
  return { dow, mins, dateKey };
}

function toMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

async function main() {
  const pub = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const priv = (process.env.VAPID_PRIVATE_KEY || '').trim();
  if (!pub || !priv) {
    console.log('VAPID keys missing from the environment — add the repo secrets. Skipping.');
    return;
  }
  const raw = readJson(SUB_PATH, null);
  // One device (object) or several (array: phone + laptop).
  const subs = (Array.isArray(raw) ? raw : [raw]).filter((x) => x && x.endpoint);
  if (!subs.length) {
    console.log('No data/subscription.json yet — nothing to send to. Skipping.');
    return;
  }
  webpush.setVapidDetails('mailto:rohit.socialenza@gmail.com', pub, priv);

  if (process.env.TEST_PUSH === '1') {
    for (const sub of subs) {
      try { await webpush.sendNotification(sub, JSON.stringify({ id: 'test', title: 'Discipline Engine', body: 'Test push: reminders are live.' }), { TTL: 600, urgency: 'high' }); console.log('Test push sent'); }
      catch (err) { console.error('Test push failed:', err.statusCode || err.message); process.exitCode = 1; }
    }
    return;
  }

  const schedule = readJson(SCHEDULE_PATH, { items: [] }).items;
  const { dow, mins, dateKey } = nowInToronto();
  const sentAll = readJson(SENT_PATH, {});
  const sentToday = sentAll[dateKey] || [];

  const due = schedule.filter((it) => {
    if (!it.days.includes(dow)) return false;
    if (sentToday.includes(it.id)) return false;
    const t = toMin(it.t);
    const win = it.id.startsWith('nx-') ? NUDGE_WINDOW : WINDOW_MINUTES;
    return mins >= t && mins < t + win;
  });

  if (!due.length) {
    console.log(`Nothing due at ${dateKey} ${mins} min (dow ${dow}).`);
    return;
  }

  let alive = subs.slice();
  for (const it of due) {
    const late = mins - toMin(it.t);
    const body = late > LATE_AFTER ? `${it.body} (${late} min late: do not wait for another reminder.)` : it.body;
    const payload = JSON.stringify({ id: it.id, title: it.title, body });
    let delivered = false;
    for (const sub of alive.slice()) {
      try {
        await webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high' });
        delivered = true;
      } catch (err) {
        console.error(`Failed to send ${it.title}:`, err.statusCode || err.message);
        // 404/410 means the subscription is gone (uninstalled, permission revoked).
        if (err.statusCode === 404 || err.statusCode === 410) alive = alive.filter((x) => x !== sub);
      }
    }
    if (delivered) { console.log(`Sent: ${it.title}`); sentToday.push(it.id); }
  }
  if (alive.length !== subs.length) {
    fs.writeFileSync(SUB_PATH, alive.length ? JSON.stringify(alive.length === 1 ? alive[0] : alive, null, 1) + '\n' : '{}\n');
    console.log('Dropped expired subscription(s). Re-subscribe in Settings if you stopped getting alerts.');
  }

  sentAll[dateKey] = sentToday;
  // keep the log from growing forever
  for (const k of Object.keys(sentAll)) if (k < dateKey) delete sentAll[k];
  fs.writeFileSync(SENT_PATH, JSON.stringify(sentAll, null, 1) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
