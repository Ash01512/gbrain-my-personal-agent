// Self-contained dashboard. Inlined rather than served from an asset bucket
// so the Worker stays a single deployable with no build step and no CDN
// dependency. The API token lives in localStorage and is sent per request;
// it never touches the URL, so it stays out of browser history and logs.

const STATUSES = [
  'saved',
  'applied',
  'screening',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
]

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
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a; --panel: #1c1f25; --text: #e8eaed; --muted: #9aa2ad;
      --line: #2c313a; --accent: #6a9bff; --danger: #f0796b;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; background: var(--bg); color: var(--text);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 16px; }
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
  button.primary { background: var(--accent); color: #fff; border-color: transparent; }
  button.link {
    background: none; border: none; color: var(--danger);
    padding: 2px 4px; text-decoration: underline;
  }
  .stats { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip {
    border: 1px solid var(--line); border-radius: 999px;
    padding: 4px 11px; font-size: 13px; color: var(--muted);
  }
  .chip b { color: var(--text); }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: 12px;
       text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
  td a { color: var(--accent); }
  .muted { color: var(--muted); }
  .msg { padding: 10px 12px; border-radius: 7px; margin-bottom: 12px; display: none; }
  .msg.err { display: block; background: #c8372d1a; color: var(--danger); }
  .msg.ok { display: block; background: #2f6feb1a; color: var(--accent); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; }
</style>
</head>
<body>
<main>
  <h1>Job Tracker</h1>
  <div id="msg" class="msg"></div>

  <div class="panel">
    <div class="row">
      <input id="token" type="password" placeholder="API token" autocomplete="current-password">
      <button class="primary" id="save-token">Connect</button>
      <span class="muted" id="conn">not connected</span>
    </div>
  </div>

  <div class="panel"><div class="stats" id="stats"><span class="muted">No data yet.</span></div></div>

  <div class="panel">
    <form id="add" class="grid">
      <input name="company" placeholder="Company *" required>
      <input name="role" placeholder="Role *" required>
      <input name="location" placeholder="Location">
      <input name="job_url" placeholder="Job URL">
      <input name="source" placeholder="Source">
      <input name="salary_range" placeholder="Salary range">
      <select name="status">${STATUSES.map(
        (s) => `<option value="${s}">${s}</option>`,
      ).join('')}</select>
      <button class="primary" type="submit">Add application</button>
    </form>
  </div>

  <div class="panel">
    <div class="row" style="margin-bottom:12px">
      <input id="q" placeholder="Search company or role">
      <select id="filter">
        <option value="">All statuses</option>
        ${STATUSES.map((s) => `<option value="${s}">${s}</option>`).join('')}
      </select>
      <button id="refresh">Refresh</button>
    </div>
    <div class="scroll">
      <table>
        <thead><tr>
          <th>Company</th><th>Role</th><th>Status</th><th>Location</th>
          <th>Applied</th><th>Link</th><th></th>
        </tr></thead>
        <tbody id="rows"><tr><td colspan="7" class="muted">Connect to load.</td></tr></tbody>
      </table>
    </div>
  </div>
</main>
<script>
const STATUSES = ${JSON.stringify(STATUSES)};
const $ = (id) => document.getElementById(id);
let token = localStorage.getItem('jt_token') || '';
$('token').value = token;

function say(text, kind) {
  const el = $('msg');
  el.textContent = text;
  el.className = 'msg ' + kind;
  if (kind === 'ok') setTimeout(() => { el.className = 'msg'; }, 2500);
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
  if (!res.ok) throw new Error(body.error || ('request failed (' + res.status + ')'));
  return body;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function loadStats() {
  const { total, by_status } = await api('/stats');
  $('stats').innerHTML =
    '<span class="chip">total <b>' + total + '</b></span>' +
    STATUSES.map((s) => '<span class="chip">' + s + ' <b>' + (by_status[s] || 0) + '</b></span>').join('');
}

async function loadRows() {
  const params = new URLSearchParams();
  if ($('q').value.trim()) params.set('q', $('q').value.trim());
  if ($('filter').value) params.set('status', $('filter').value);
  const { data } = await api('/applications?' + params.toString());

  $('rows').innerHTML = data.length
    ? data.map((r) => \`<tr>
        <td>\${esc(r.company)}</td>
        <td>\${esc(r.role)}</td>
        <td><select data-id="\${r.id}" class="status">\${STATUSES.map((s) =>
          '<option value="' + s + '"' + (s === r.status ? ' selected' : '') + '>' + s + '</option>'
        ).join('')}</select></td>
        <td>\${esc(r.location) || '<span class="muted">-</span>'}</td>
        <td>\${esc(r.applied_on) || '<span class="muted">-</span>'}</td>
        <td>\${r.job_url ? '<a href="' + esc(r.job_url) + '" target="_blank" rel="noopener">open</a>' : '<span class="muted">-</span>'}</td>
        <td><button class="link" data-del="\${r.id}">delete</button></td>
      </tr>\`).join('')
    : '<tr><td colspan="7" class="muted">No applications yet.</td></tr>';
}

async function refresh() {
  if (!token) { say('Enter your API token to connect.', 'err'); return; }
  try {
    await Promise.all([loadStats(), loadRows()]);
    $('conn').textContent = 'connected';
  } catch (err) {
    $('conn').textContent = 'not connected';
    say(err.message, 'err');
  }
}

$('save-token').onclick = () => {
  token = $('token').value.trim();
  localStorage.setItem('jt_token', token);
  refresh();
};
$('refresh').onclick = refresh;
$('q').onkeydown = (e) => { if (e.key === 'Enter') refresh(); };
$('filter').onchange = refresh;

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
    loadStats();
  } catch (err) { say(err.message, 'err'); }
});

document.addEventListener('click', async (e) => {
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
