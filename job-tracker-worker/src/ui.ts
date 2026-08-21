// Self-contained dashboard. Inlined rather than served from an asset bucket
// so the Worker stays a single deployable with no build step and no CDN
// dependency. The API token lives in localStorage and is sent per request;
// it never touches the URL, so it stays out of browser history and logs.
//
// The page is laid out as a review queue, not a CRUD admin tool: the scored
// list is the first thing under the heading, and manual entry and the token
// field fold away once they are not needed.

const STATUSES = [
  'saved',
  'applied',
  'screening',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
]

/**
 * The pure helpers the page runs, kept as source so tests can evaluate the
 * exact text that ships rather than a parallel copy that can drift.
 *
 * `safeUrl` is the client half of the URL-scheme guard. `schema.ts` already
 * refuses to store anything but http/https, but rows predating that rule — or
 * written by anything else holding the token — would otherwise reach an
 * `href` and a `window.open()`. A `javascript:` URL there executes on the
 * Worker's own origin and can read the API token out of localStorage, and
 * that token fronts a service-role key that bypasses RLS. Third-party job
 * postings are exactly the untrusted input this page renders, so the check
 * belongs at the sink too, not only at the door.
 */
export const CLIENT_HELPERS = `
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

// The score is what the eye should sort on, so it carries a tier as well as a
// number. A zero is a real score and must not render as "no score".
function scoreCell(score) {
  if (score === null || score === undefined) {
    return '<span class="score none" title="The agent did not score this one">—</span>';
  }
  const value = Number(score);
  const tier = value >= 8 ? 'high' : value >= 6 ? 'mid' : 'low';
  return '<span class="score ' + tier + '">' + value.toFixed(1) +
    '<span class="denom">/10</span></span>';
}

// A capped tally must not read as a real total.
function capped(value, truncated) {
  return truncated ? value + '+' : String(value);
}
`

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Tracker</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --panel: #fff; --text: #14161a; --muted: #5c6370;
    --line: #dfe3e8; --accent: #2f6feb; --danger: #c8372d;
    /* Foreground for text sitting on --accent, so contrast survives both themes. */
    --on-accent: #fff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a; --panel: #1c1f25; --text: #e8eaed; --muted: #9aa2ad;
      --line: #2c313a; --accent: #6a9bff; --danger: #f0796b;
      /* White on #6a9bff is about 2.7:1 and fails AA. Dark text on it passes. */
      --on-accent: #0d1117;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; background: var(--bg); color: var(--text);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 1080px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; }
  h1 { font-size: 20px; margin: 0; }
  .panel {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 16px; margin-bottom: 16px;
  }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  input, select, textarea, button {
    font: inherit; color: inherit; background: var(--panel);
    border: 1px solid var(--line); border-radius: 7px; padding: 7px 9px;
  }
  input, select { min-width: 150px; }
  button { cursor: pointer; }
  button.primary { background: var(--accent); color: var(--on-accent); border-color: transparent; }
  button[disabled] { opacity: .55; cursor: progress; }
  button.link {
    background: none; border: none; color: var(--muted);
    padding: 2px 4px; text-decoration: none;
  }
  /* Delete is destructive and rare. It earns its red on hover, not in every row. */
  button.link:hover, button.link:focus-visible { color: var(--danger); text-decoration: underline; }
  /* The browser default ring is close to invisible on a filled accent button. */
  :focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
  .visually-hidden {
    position: absolute; width: 1px; height: 1px; overflow: hidden;
    clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
  }

  /* Headline stat: the number the whole loop exists to make true. */
  .headline { display: flex; align-items: flex-end; gap: 18px; flex-wrap: wrap; }
  .big { font-size: 40px; line-height: 1; font-variant-numeric: tabular-nums; }
  .headline .cap { color: var(--muted); font-size: 13px; }
  .spark { display: flex; align-items: flex-end; gap: 6px; height: 44px; }
  .spark > div { width: 22px; }
  .spark > div > div { background: var(--line); border-radius: 3px 3px 0 0; }
  .spark > div > div.on { background: var(--accent); }
  .spark span { display: block; text-align: center; font-size: 10px; color: var(--muted); }
  .stats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px;
           padding-top: 12px; border-top: 1px solid var(--line); }
  .chip {
    border: 1px solid var(--line); border-radius: 999px;
    padding: 3px 10px; font-size: 12px; color: var(--muted);
  }
  .chip b { color: var(--text); font-weight: 600; }

  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 10px; border-bottom: 1px solid var(--line);
           vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 12px;
       text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
  td a { color: var(--accent); }
  .muted { color: var(--muted); }
  .score { font-size: 21px; font-variant-numeric: tabular-nums; line-height: 1.2;
           display: inline-block; }
  .score .denom { font-size: 11px; color: var(--muted); margin-left: 1px; }
  .score.high { color: var(--accent); font-weight: 650; }
  .score.low, .score.none { color: var(--muted); }
  .title { font-weight: 600; }
  .why { color: var(--muted); font-size: 13px; margin-top: 3px;
         display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
         overflow: hidden; }
  .why.open { -webkit-line-clamp: unset; }
  .why-toggle { font-size: 12px; padding-left: 0; }
  .nolink { font-size: 12px; }
  /* Kept a normal table-cell on desktop — making it a flex container drops the
     row border and squeezes the button label onto two lines. */
  td.actions { white-space: nowrap; }
  td.actions > * { vertical-align: middle; }
  td.actions > * + * { margin-left: 10px; }

  .msg { padding: 10px 12px; border-radius: 7px; margin-bottom: 12px; display: none;
         position: sticky; top: 0; z-index: 5; }
  .msg.err { display: block; background: #c8372d1a; color: var(--danger); }
  .msg.ok { display: block; background: #2f6feb1a; color: var(--accent); }
  .msg button { margin-left: 10px; padding: 2px 8px; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; }
  details > summary { cursor: pointer; color: var(--muted); font-size: 14px; }
  details[open] > summary { margin-bottom: 12px; }

  /* Below this width the seven-column table put Status and Apply — the only
     two interactive controls — offscreen behind a horizontal scroll. */
  @media (max-width: 700px) {
    body { padding: 12px; }
    input, select { min-width: 0; }
    #add input, #add select { width: 100%; }
    table, tbody, tr, td { display: block; width: 100%; }
    thead { display: none; }
    tr { border: 1px solid var(--line); border-radius: 9px; padding: 10px;
         margin-bottom: 10px; }
    td { border: none; padding: 3px 0; }
    td.actions { display: flex; gap: 10px; align-items: center;
                 justify-content: space-between; margin-top: 8px; }
    td.actions > * + * { margin-left: 0; }
    .headline { flex-direction: column; align-items: flex-start; gap: 14px; }
    td[data-label]::before {
      content: attr(data-label) " ";
      color: var(--muted); font-size: 11px; text-transform: uppercase;
      letter-spacing: .04em; margin-right: 6px;
    }
    td.fit::before, td.job::before { content: none; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>Job Tracker</h1>
    <span class="muted" id="conn">not connected</span>
  </header>

  <!-- Announced, sticky, and slow to clear: the apply flow sends you to
       another tab, so feedback has to survive the trip back. -->
  <div id="msg" class="msg" role="status" aria-live="polite"></div>

  <div class="panel">
    <div class="headline">
      <div>
        <div class="big" id="today">–</div>
        <div class="cap">applications you recorded today</div>
      </div>
      <div>
        <div class="spark" id="spark"></div>
        <div class="cap">last 7 days</div>
      </div>
    </div>
    <div class="stats" id="stats"><span class="muted">No data yet.</span></div>
  </div>

  <div class="panel">
    <div class="row" style="margin-bottom:12px">
      <label class="visually-hidden" for="q">Search company or role</label>
      <input id="q" placeholder="Search company or role">
      <label class="visually-hidden" for="filter">Filter by status</label>
      <select id="filter">
        <option value="">All statuses</option>
        ${STATUSES.map((s) => `<option value="${s}">${s}</option>`).join('')}
      </select>
      <label class="visually-hidden" for="track">Filter by track</label>
      <select id="track">
        <option value="">Both tracks</option>
        <option value="ai">AI &amp; data roles</option>
        <option value="facilities">Facilities leadership</option>
        <option value="none">Untracked</option>
      </select>
      <label class="visually-hidden" for="sort">Sort order</label>
      <select id="sort">
        <option value="queue">Unsent, best fit first</option>
        <option value="all">Everything, newest first</option>
      </select>
      <button id="refresh">Refresh</button>
    </div>
    <div class="scroll">
      <table>
        <thead><tr>
          <th>Fit</th><th>Role</th><th>Status</th><th>Applied</th><th></th>
        </tr></thead>
        <tbody id="rows"><tr><td colspan="5" class="muted">Connect to load.</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <details id="add-panel">
      <summary>Add an application manually</summary>
      <form id="add" class="grid">
        <label class="visually-hidden" for="f-company">Company</label>
        <input id="f-company" name="company" placeholder="Company *" required>
        <label class="visually-hidden" for="f-role">Role</label>
        <input id="f-role" name="role" placeholder="Role *" required>
        <label class="visually-hidden" for="f-location">Location</label>
        <input id="f-location" name="location" placeholder="Location">
        <label class="visually-hidden" for="f-url">Job URL</label>
        <input id="f-url" name="job_url" type="url" placeholder="Job URL (http or https)">
        <label class="visually-hidden" for="f-source">Source</label>
        <input id="f-source" name="source" placeholder="Source">
        <label class="visually-hidden" for="f-salary">Salary range</label>
        <input id="f-salary" name="salary_range" placeholder="Salary range">
        <label class="visually-hidden" for="f-status">Status</label>
        <select id="f-status" name="status">${STATUSES.map(
          (s) => `<option value="${s}">${s}</option>`,
        ).join('')}</select>
        <button class="primary" type="submit">Add application</button>
      </form>
    </details>
  </div>

  <div class="panel">
    <details id="token-panel">
      <summary>Connection</summary>
      <div class="row">
        <label class="visually-hidden" for="token">API token</label>
        <input id="token" type="password" placeholder="API token" autocomplete="current-password">
        <button class="primary" id="save-token">Connect</button>
      </div>
    </details>
  </div>
</main>
<script>
const STATUSES = ${JSON.stringify(STATUSES)};
const $ = (id) => document.getElementById(id);
let token = localStorage.getItem('jt_token') || '';
$('token').value = token;
$('token-panel').open = !token;

let clearTimer;
/** \`action\` is an optional { label, run } rendered as a button in the message. */
function say(text, kind, action) {
  const el = $('msg');
  clearTimeout(clearTimer);
  el.textContent = text;
  el.className = 'msg ' + kind;
  if (action) {
    const button = document.createElement('button');
    button.textContent = action.label;
    button.onclick = () => { el.className = 'msg'; action.run(); };
    el.appendChild(button);
  }
  // An offer to undo has to outlast a glance away at another tab.
  if (kind === 'ok') {
    clearTimer = setTimeout(() => { el.className = 'msg'; }, action ? 12000 : 4000);
  }
}

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + token,
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The status travels with the error so a caller can tell "already
    // recorded" (409) from "we could not reach the database" (502).
    const err = new Error(body.error || ('request failed (' + res.status + ')'));
    err.status = res.status;
    throw err;
  }
  return body;
}
${CLIENT_HELPERS}
function bar(count, max, label) {
  const height = max > 0 ? Math.max(3, Math.round((count / max) * 40)) : 3;
  return '<div>' +
    '<div class="' + (count > 0 ? 'on' : '') + '" style="height:' + height + 'px" ' +
    'title="' + esc(label) + ': ' + count + '"></div>' +
    '<span>' + esc(label.slice(8)) + '</span></div>';
}

async function loadStats() {
  const [stats, daily] = await Promise.all([api('/stats'), api('/stats/daily')]);
  $('today').textContent = daily.today;
  const week = daily.days.slice(0, 7).reverse();
  const max = Math.max(...week.map((d) => d.count));
  $('spark').innerHTML = week.map((d) => bar(d.count, max, d.date)).join('');
  $('stats').innerHTML =
    '<span class="chip">submitted all time <b>' + capped(daily.total, daily.truncated) + '</b></span>' +
    '<span class="chip">tracked <b>' + capped(stats.total, stats.truncated) + '</b></span>' +
    '<span class="chip" style="border:none">pipeline:</span>' +
    STATUSES.map((s) =>
      '<span class="chip">' + s + ' <b>' + (stats.by_status[s] || 0) + '</b></span>'
    ).join('');
}

function emptyRow() {
  // Four different situations used to share one "Nothing in the queue", so a
  // user who forgot a filter concluded the agent was broken.
  const filtered = $('q').value.trim() || $('filter').value || $('track').value;
  if (filtered) {
    return '<tr><td colspan="5" class="muted">No matches for these filters. ' +
      '<button class="link" id="clear-filters">Clear filters</button></td></tr>';
  }
  if ($('sort').value === 'queue') {
    return '<tr><td colspan="5" class="muted">Queue clear — you have reviewed ' +
      'everything the agent found.</td></tr>';
  }
  return '<tr><td colspan="5" class="muted">Nothing tracked yet.</td></tr>';
}

function rowHtml(r) {
  // Anything that is not http/https never reaches an href or window.open.
  const url = safeUrl(r.job_url);
  const who = esc(r.company) + (r.location ? ' · ' + esc(r.location) : '');
  const label = esc(r.company) + ' — ' + esc(r.role);
  const action = r.status === 'saved'
    ? (url
        ? '<button class="primary" data-apply="' + esc(r.id) + '" data-url="' + esc(url) + '"' +
          ' title="Opens the posting in a new tab and records this as applied">Apply ↗</button>'
        : '<span class="chip nolink" title="The agent captured no usable link for this posting">no link</span>')
    : (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">open ↗</a>' : '');

  return \`<tr>
    <td class="fit" data-label="Fit">\${scoreCell(r.match_score)}</td>
    <td class="job">
      <div class="title">\${esc(r.role)}</div>
      <div class="muted" style="font-size:13px">\${who}</div>
      \${r.match_rationale
        ? '<div class="why">' + esc(r.match_rationale) + '</div>' +
          '<button class="link why-toggle">why?</button>'
        : ''}
    </td>
    <td data-label="Status">
      <select data-id="\${esc(r.id)}" class="status" aria-label="Status for \${label}">\${
        STATUSES.map((s) =>
          '<option value="' + s + '"' + (s === r.status ? ' selected' : '') + '>' + s + '</option>'
        ).join('')}</select>
    </td>
    <td data-label="Applied">\${esc(r.applied_on) || '<span class="muted">–</span>'}</td>
    <td class="actions">
      \${action}
      <button class="link" data-del="\${esc(r.id)}" aria-label="Delete \${label}">delete</button>
    </td>
  </tr>\`;
}

async function loadRows() {
  const params = new URLSearchParams();
  if ($('q').value.trim()) params.set('q', $('q').value.trim());
  if ($('filter').value) params.set('status', $('filter').value);
  if ($('track').value) params.set('track', $('track').value);
  if ($('sort').value === 'queue') params.set('queue', 'true');
  const { data } = await api('/applications?' + params.toString());
  $('rows').innerHTML = data.length ? data.map(rowHtml).join('') : emptyRow();
}

async function refresh() {
  if (!token) {
    $('token-panel').open = true;
    say('Enter your API token to connect.', 'err');
    return;
  }
  $('rows').style.opacity = '.5';
  // Settled, not all: a failing /stats used to blank out a queue that had
  // loaded correctly and tell the user they were disconnected.
  const [stats, rows] = await Promise.allSettled([loadStats(), loadRows()]);
  $('rows').style.opacity = '';
  if (rows.status === 'rejected') {
    $('rows').innerHTML = '<tr><td colspan="5" class="err">' + esc(rows.reason.message) + '</td></tr>';
  }
  if (stats.status === 'rejected') {
    $('stats').innerHTML = '<span class="muted">Counts unavailable: ' + esc(stats.reason.message) + '</span>';
  }
  const failure = [rows, stats].find((r) => r.status === 'rejected');
  $('conn').textContent = failure ? 'not connected' : 'connected';
  if (failure) say(failure.reason.message, 'err');
  else $('token-panel').open = false;
}

$('save-token').onclick = () => {
  token = $('token').value.trim();
  localStorage.setItem('jt_token', token);
  refresh();
};
$('refresh').onclick = refresh;
$('q').onkeydown = (e) => { if (e.key === 'Enter') refresh(); };
$('filter').onchange = refresh;
$('track').onchange = refresh;
$('sort').onchange = refresh;

$('add').onsubmit = async (e) => {
  e.preventDefault();
  const payload = {};
  for (const [key, value] of new FormData(e.target).entries()) {
    if (String(value).trim()) payload[key] = String(value).trim();
  }
  try {
    await api('/applications', { method: 'POST', body: JSON.stringify(payload) });
    e.target.reset();
    say('Added.', 'ok');
    refresh();
  } catch (err) { say(err.message, 'err'); }
};

document.addEventListener('change', async (e) => {
  if (!e.target.classList.contains('status')) return;
  try {
    await api('/applications/' + e.target.dataset.id, {
      method: 'PATCH',
      body: JSON.stringify({ status: e.target.value }),
    });
    say('Updated.', 'ok');
    refresh();
  } catch (err) { say(err.message, 'err'); refresh(); }
});

async function undoApply(id) {
  try {
    // Back to 'saved' also clears applied_on server-side, so the day's count
    // returns to the truth rather than keeping a send that never happened.
    await api('/applications/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'saved' }) });
    say('Undone — back in the queue, and removed from today.', 'ok');
  } catch (err) { say(err.message, 'err'); }
  refresh();
}

document.addEventListener('click', async (e) => {
  if (e.target.id === 'clear-filters') {
    $('q').value = ''; $('filter').value = ''; $('track').value = '';
    refresh();
    return;
  }

  if (e.target.classList.contains('why-toggle')) {
    const why = e.target.previousElementSibling;
    why.classList.toggle('open');
    e.target.textContent = why.classList.contains('open') ? 'less' : 'why?';
    return;
  }

  const applyId = e.target.dataset?.apply;
  if (applyId) {
    // Re-checked at the sink: dataset is read back decoded, so the entity
    // escaping that made the attribute safe does not survive to here.
    const target = safeUrl(e.target.dataset.url);
    if (!target) { say('That posting has no usable http(s) link.', 'err'); return; }

    // Opened synchronously inside the click so the popup blocker allows it.
    // You submit the application yourself in that tab; this only records it.
    //
    // The 'noopener' feature is NOT passed: with it, window.open returns null
    // unconditionally, which is indistinguishable from a blocked popup — so
    // every apply would report "popup blocked" and record nothing. Clearing
    // opener on the handle gives the same protection and keeps the answer.
    const opened = window.open(target, '_blank');
    if (opened) {
      opened.opener = null;
    } else {
      // Recording an application the user never saw would put a number in the
      // daily count that nothing backs.
      say('Popup blocked. Allow popups for this page, or open the posting yourself first.', 'err');
      return;
    }

    // A click during the round trip would fire a second apply. The server
    // answers 409, but the button should not invite it.
    const button = e.target;
    button.disabled = true;
    button.textContent = 'recording…';
    try {
      await api('/applications/' + applyId + '/apply', { method: 'POST' });
      say('Recorded as applied. Finish the form in the tab that just opened.', 'ok', {
        label: 'Undo',
        run: () => undoApply(applyId),
      });
    } catch (err) {
      // 409 means the database already has it — that is agreement, not an
      // error. Either way refresh: leaving the row showing "saved" would have
      // the screen assert the opposite of what was stored.
      if (err.status === 409) say('Already recorded as applied.', 'ok');
      else say(err.message + ' — reloading to show what was actually saved.', 'err');
    }
    refresh();
    return;
  }

  const id = e.target.dataset?.del;
  if (!id || !confirm('Delete this application?')) return;
  try {
    await api('/applications/' + id, { method: 'DELETE' });
    say('Deleted.', 'ok');
    refresh();
  } catch (err) { say(err.message, 'err'); }
});

if (token) refresh();
</script>
</body>
</html>`
}
