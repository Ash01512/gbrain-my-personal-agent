// Self-contained approval dashboard. Inlined rather than served from an asset
// bucket so the Worker stays a single deployable with no build step and no CDN
// dependency. The API token lives in localStorage and is sent per request; it
// never touches the URL, so it stays out of browser history and logs.
//
// Laid out as a review queue rather than a CRUD admin tool, and blocked rows
// sort to the top: the thing a person needs to see first is what they are not
// allowed to send and why.

/**
 * Pure helpers the page runs, kept as source so tests can evaluate the exact
 * text that ships rather than a parallel copy that can drift.
 *
 * `safeUrl` is the client half of the URL-scheme guard. schema.ts already
 * refuses to store anything but http/https, but rows written before that rule
 * — or by anything else holding the token — would otherwise reach an `href`.
 * A `javascript:` URL there executes on this origin and can read the API token
 * out of localStorage, and that token fronts a service-role key that bypasses
 * RLS. Listing sheets are exactly the untrusted input this page renders.
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

// Gate codes are stored, not sentences, so the queue turns them back into
// something a person can act on. An unknown code must still render: a new
// blocker that showed as blank would read as "no reason", which is the one
// thing a blocked row must never look like.
var BLOCK_LABELS = {
  NO_OPT_IN: 'No recorded opt-in — get consent before messaging',
  OPTED_OUT: 'They asked not to be contacted',
  INVALID_PHONE: 'Phone is not in E.164 format',
  TEMPLATE_MISSING: 'Template no longer exists',
  TEMPLATE_REQUIRED: 'Needs an approved template — free-form is not sent',
  TEMPLATE_NOT_APPROVED: 'Template is not approved by Meta',
  ALREADY_MESSAGED: 'This contact has already had their one message',
  UNSUPPORTED_CLAIM: 'Claims a past interaction that never happened',
  FREQUENCY_CAP: 'Contact has hit the message cap',
  EMPTY_BODY: 'Nothing to send',
};

function blockLabel(code) {
  return BLOCK_LABELS[code] || code;
}

// A capped tally must not read as a real total.
function capped(value, truncated) {
  return truncated ? value + '+' : String(value);
}

// Blocked first, then drafts, then approved. The queue is a worklist, and the
// rows that need a decision outrank the ones already decided.
var STATUS_RANK = { blocked: 0, draft: 1, failed: 2, approved: 3, sent: 4, cancelled: 5 };

function byUrgency(a, b) {
  var left = STATUS_RANK[a.status] === undefined ? 9 : STATUS_RANK[a.status];
  var right = STATUS_RANK[b.status] === undefined ? 9 : STATUS_RANK[b.status];
  if (left !== right) return left - right;
  return String(b.created_at).localeCompare(String(a.created_at));
}
`

export function dashboardHtml(live = false, autopilot = false): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Property Outreach</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --panel: #fff; --text: #14161a; --muted: #5c6370;
    --line: #dfe3e8; --accent: #2f6feb; --danger: #c8372d; --warn: #b26a00;
    --ok: #1f7a44;
    /* Foreground for text sitting on --accent, so contrast survives both themes. */
    --on-accent: #fff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a; --panel: #1c1f25; --text: #e8eaed; --muted: #9aa2ad;
      --line: #2c313a; --accent: #6a9bff; --danger: #f0796b;
      --warn: #e0a34a; --ok: #5ec98a;
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
  header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 15px; margin: 0 0 10px; }
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
  textarea { width: 100%; min-height: 70px; resize: vertical; }
  button { cursor: pointer; }
  button.primary { background: var(--accent); color: var(--on-accent); border-color: transparent; }
  button[disabled] { opacity: .55; cursor: not-allowed; }
  button.link { background: none; border: none; color: var(--muted); padding: 2px 4px; }
  button.link:hover, button.link:focus-visible { color: var(--danger); text-decoration: underline; }
  :focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
  .muted { color: var(--muted); }
  .small { font-size: 13px; }

  /* The dry-run banner is not decoration. Someone wondering why no message
     arrived should find the answer before they start debugging the provider. */
  .mode {
    border-radius: 10px; padding: 10px 14px; margin-bottom: 16px;
    border: 1px solid var(--line); font-size: 14px;
  }
  .mode.dry { border-color: var(--warn); color: var(--warn); }
  .mode.live { border-color: var(--danger); color: var(--danger); font-weight: 600; }

  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip {
    border: 1px solid var(--line); border-radius: 999px;
    padding: 4px 11px; font-size: 13px;
  }
  .chip b { font-weight: 600; }

  .msg {
    border: 1px solid var(--line); border-radius: 9px;
    padding: 12px 14px; margin-bottom: 10px;
  }
  .msg.blocked { border-left: 3px solid var(--danger); }
  .msg.draft { border-left: 3px solid var(--warn); }
  .msg.approved { border-left: 3px solid var(--ok); }
  .msg.sent { opacity: .7; }
  .msg .top { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .msg .body {
    white-space: pre-wrap; margin: 8px 0; padding: 9px 11px;
    background: var(--bg); border-radius: 7px; font-size: 14px;
  }
  .status {
    font-size: 12px; text-transform: uppercase; letter-spacing: .04em;
    border: 1px solid var(--line); border-radius: 5px; padding: 1px 7px;
  }
  ul.blockers { margin: 6px 0 0; padding-left: 18px; color: var(--danger); font-size: 13px; }
  .actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  details summary { cursor: pointer; color: var(--muted); font-size: 14px; }
  .visually-hidden {
    position: absolute; width: 1px; height: 1px; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap;
  }
  #toast {
    position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    padding: 9px 14px; box-shadow: 0 6px 22px rgba(0,0,0,.18); max-width: 90vw;
  }
  #toast[hidden] { display: none; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Property Outreach</h1>
    <span class="muted small">approval queue</span>
  </header>

  <div class="mode ${live && autopilot ? 'live' : 'dry'}">
    ${
      live && autopilot
        ? 'LIVE + AUTOPILOT — the hourly cron is sending real WhatsApp messages on its own. This queue is a record of what it did, not a gate it waits on.'
        : live
          ? 'LIVE, autopilot off — nothing sends unless you press Send here. Set OUTREACH_AUTOPILOT to "true" to let the cron run it.'
          : autopilot
            ? 'Autopilot rehearsing — the cron runs hourly, selects real contacts and builds real payloads, but OUTREACH_LIVE is not "true" so nothing is transmitted. Read a few runs in the logs, then go live.'
            : 'Dry run — nothing sends. Send returns the payload it <em>would</em> have posted, so you can confirm it against docs.letsbot.net before arming anything.'
    }
  </div>

  <p class="muted small" style="margin:-6px 0 16px">
    Opt-ins are collected at <a href="/optin">/optin</a> — that page is the only
    way anyone enters the sendable list.
  </p>

  <details class="panel" id="tokenPanel">
    <summary>API token</summary>
    <div class="row" style="margin-top:10px">
      <label class="visually-hidden" for="token">API token</label>
      <input id="token" type="password" placeholder="API_TOKEN" autocomplete="off">
      <button class="primary" id="saveToken">Save</button>
      <span class="muted small">Stored in this browser only.</span>
    </div>
  </details>

  <section class="panel">
    <h2>Where you stand</h2>
    <div class="chips" id="chips"><span class="muted small">loading…</span></div>
    <p class="muted small" id="sendableNote" style="margin:10px 0 0"></p>
  </section>

  <section class="panel">
    <h2>Record a consent</h2>
    <p class="muted small" style="margin-top:0">
      Nothing can be sent to a contact until an opt-in is recorded against evidence.
      Paste where and when they agreed — a form submission, a click-to-WhatsApp ad,
      a signed sheet, or their own first message to you.
    </p>
    <div class="row">
      <label class="visually-hidden" for="consentContact">Contact id</label>
      <input id="consentContact" placeholder="contact UUID">
      <label class="visually-hidden" for="consentEvent">Event</label>
      <select id="consentEvent">
        <option value="opt_in">opt in</option>
        <option value="opt_out">opt out</option>
      </select>
      <label class="visually-hidden" for="consentMethod">Method</label>
      <select id="consentMethod">
        <option value="website_form">website form</option>
        <option value="click_to_whatsapp_ad">click-to-WhatsApp ad</option>
        <option value="inbound_message">they messaged first</option>
        <option value="in_person_written">in person, written</option>
        <option value="phone_recorded">phone, recorded</option>
        <option value="imported_documented">imported, documented</option>
        <option value="user_request">they asked</option>
      </select>
      <label class="visually-hidden" for="consentNote">Evidence</label>
      <input id="consentNote" placeholder="evidence — where and when" style="flex:1;min-width:240px">
      <button class="primary" id="saveConsent">Record</button>
    </div>
  </section>

  <section class="panel">
    <div class="row" style="justify-content:space-between">
      <h2 style="margin:0">Queue</h2>
      <div class="row">
        <label class="visually-hidden" for="filter">Status</label>
        <select id="filter">
          <option value="">needs a decision</option>
          <option value="blocked">blocked</option>
          <option value="draft">draft</option>
          <option value="approved">approved</option>
          <option value="sent">sent</option>
          <option value="cancelled">cancelled</option>
        </select>
        <button id="refresh">Refresh</button>
      </div>
    </div>
    <div id="queue" style="margin-top:12px"><span class="muted small">loading…</span></div>
  </section>
</main>

<div id="toast" hidden role="status" aria-live="polite"></div>

<script>
${CLIENT_HELPERS}

var TOKEN_KEY = 'property-outreach-token';
var token = localStorage.getItem(TOKEN_KEY) || '';
var tokenInput = document.getElementById('token');
var tokenPanel = document.getElementById('tokenPanel');
tokenInput.value = token;
if (!token) tokenPanel.open = true;

function toast(message, isError) {
  var el = document.getElementById('toast');
  el.textContent = message;
  el.style.borderColor = isError ? 'var(--danger)' : 'var(--line)';
  el.hidden = false;
  clearTimeout(el._timer);
  el._timer = setTimeout(function () { el.hidden = true; }, 4200);
}

async function api(path, options) {
  options = options || {};
  var response = await fetch(path, {
    method: options.method || 'GET',
    headers: Object.assign(
      { 'content-type': 'application/json' },
      token ? { authorization: 'Bearer ' + token } : {}
    ),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  var payload = await response.json().catch(function () { return {}; });
  if (!response.ok) {
    // Blockers are the useful half of a 409 and must reach the person, not
    // just the console.
    var reasons = (payload.blockers || []).map(function (b) { return b.detail; }).join('; ');
    throw new Error(reasons || payload.error || ('request failed (' + response.status + ')'));
  }
  return payload;
}

document.getElementById('saveToken').addEventListener('click', function () {
  token = tokenInput.value.trim();
  localStorage.setItem(TOKEN_KEY, token);
  tokenPanel.open = false;
  toast('Token saved');
  loadAll();
});

document.getElementById('refresh').addEventListener('click', loadAll);
document.getElementById('filter').addEventListener('change', loadQueue);

document.getElementById('saveConsent').addEventListener('click', async function () {
  var id = document.getElementById('consentContact').value.trim();
  var note = document.getElementById('consentNote').value.trim();
  var method = document.getElementById('consentMethod').value;
  var event = document.getElementById('consentEvent').value;
  if (!id) return toast('Contact id is required', true);
  if (event === 'opt_in' && method !== 'inbound_message' && !note) {
    return toast('An opt-in needs evidence', true);
  }
  try {
    await api('/api/contacts/' + encodeURIComponent(id) + '/consent', {
      method: 'POST',
      body: { event: event, method: method, evidence_note: note || null },
    });
    document.getElementById('consentNote').value = '';
    toast('Recorded');
    loadAll();
  } catch (error) {
    toast(error.message, true);
  }
});

async function loadStats() {
  var chips = document.getElementById('chips');
  try {
    var stats = await api('/api/stats');
    var parts = [];
    parts.push('<span class="chip">contacts <b>' +
      capped(stats.contacts.total, stats.contacts.truncated) + '</b></span>');
    parts.push('<span class="chip">can be messaged <b>' +
      esc(stats.sendable_contacts) + '</b></span>');
    Object.keys(stats.messages.by_status).sort().forEach(function (status) {
      parts.push('<span class="chip">' + esc(status) + ' <b>' +
        esc(stats.messages.by_status[status]) + '</b></span>');
    });
    chips.innerHTML = parts.join('');

    var note = document.getElementById('sendableNote');
    note.textContent = stats.sendable_contacts === 0
      ? 'No contact has a recorded opt-in yet, so every message will block. That is the correct starting state for a list built from listing sheets — record consent first.'
      : 'Cap: ' + stats.limits.maxPerContact + ' messages per contact per ' +
        stats.limits.windowDays + ' days.';
  } catch (error) {
    chips.innerHTML = '<span class="muted small">' + esc(error.message) + '</span>';
  }
}

function renderMessage(message) {
  var blockers = (message.block_reasons || []).map(function (code) {
    return '<li>' + esc(blockLabel(code)) + '</li>';
  }).join('');

  var canApprove = message.status === 'draft';
  var canSend = message.status === 'approved' || message.status === 'failed';
  var canCancel = message.status !== 'sent' && message.status !== 'sending' &&
    message.status !== 'cancelled';

  return '<article class="msg ' + esc(message.status) + '">' +
    '<div class="top">' +
      '<span class="small muted">' + esc(message.contact_id) + '</span>' +
      '<span class="status">' + esc(message.status) + '</span>' +
    '</div>' +
    '<div class="body">' + esc(message.rendered_body) + '</div>' +
    (blockers ? '<ul class="blockers">' + blockers + '</ul>' : '') +
    (message.error ? '<p class="small" style="color:var(--danger)">' +
      esc(message.error) + '</p>' : '') +
    '<div class="actions">' +
      (canApprove ? '<button class="primary" data-act="approve" data-id="' +
        esc(message.id) + '">Approve</button>' : '') +
      (canSend ? '<button class="primary" data-act="send" data-id="' +
        esc(message.id) + '">Send</button>' : '') +
      (canCancel ? '<button class="link" data-act="cancel" data-id="' +
        esc(message.id) + '">Cancel</button>' : '') +
    '</div>' +
  '</article>';
}

async function loadQueue() {
  var container = document.getElementById('queue');
  var status = document.getElementById('filter').value;
  try {
    var path = status ? '/api/queue?status=' + encodeURIComponent(status) : '/api/queue';
    var payload = await api(path);
    var rows = (payload.data || []).slice().sort(byUrgency);
    container.innerHTML = rows.length
      ? rows.map(renderMessage).join('')
      : '<p class="muted small">Nothing here.</p>';
  } catch (error) {
    container.innerHTML = '<p class="muted small">' + esc(error.message) + '</p>';
  }
}

document.getElementById('queue').addEventListener('click', async function (event) {
  var button = event.target.closest('button[data-act]');
  if (!button) return;
  var act = button.dataset.act;
  var id = button.dataset.id;

  if (act === 'send' && !confirm('Send this message now?')) return;

  button.disabled = true;
  try {
    var result = await api('/api/outreach/' + encodeURIComponent(id) + '/' + act, {
      method: 'POST',
    });
    if (result.dry_run) {
      toast('Dry run — nothing was sent. Payload logged to the console.');
      console.log('would send:', result.would_send);
    } else {
      toast(act === 'approve' ? 'Approved' : act === 'send' ? 'Sent' : 'Cancelled');
    }
    loadAll();
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
  }
});

function loadAll() {
  loadStats();
  loadQueue();
}

loadAll();
</script>
</body>
</html>`
}
