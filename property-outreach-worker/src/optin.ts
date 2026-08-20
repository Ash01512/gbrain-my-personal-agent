// The public opt-in page.
//
// This is the front door the whole system depends on. Automation can only send
// to people who have opted in, so without a way to collect opt-ins the
// scheduler runs forever and sends nothing. This page is what a
// click-to-WhatsApp ad, a QR code on a board, a link in a listing, or an email
// footer points at.
//
// It is public by necessity — the people using it do not have the API token —
// which makes it the one place a stranger can write to the database. Two
// consequences are designed for below: the page can only ever create an
// opt-in for a number the submitter typed (never read one back), and the
// evidence recorded with it is the thing you would show Meta if asked.

export interface OptInSubmission {
  phone: string
  name: string | null
  contactType: 'owner' | 'buyer' | 'both'
  consented: boolean
}

export class OptInError extends Error {}

const CONTACT_TYPES = new Set(['owner', 'buyer', 'both'])

/**
 * Validates a submission from the public form.
 *
 * `consented` must be explicitly true. A form that records consent for anyone
 * who merely typed a phone number is not consent, and Meta's guidance is
 * specific that a pre-checked box does not count — so the checkbox is
 * unchecked in the markup and its absence is rejected here.
 */
export function parseSubmission(form: URLSearchParams): OptInSubmission {
  const rawPhone = (form.get('phone') ?? '').trim()
  if (!rawPhone) throw new OptInError('Please enter your WhatsApp number.')

  const phone = rawPhone.replace(/[\s()\-.]/g, '')
  const normalised = phone.startsWith('+') ? phone : `+${phone}`
  if (!/^\+[1-9]\d{7,14}$/.test(normalised)) {
    throw new OptInError('Please include your country code, for example +971 50 123 4567.')
  }

  if (form.get('consent') !== 'yes') {
    throw new OptInError('Please tick the box to agree to receive WhatsApp messages.')
  }

  const contactType = (form.get('contact_type') ?? 'buyer').trim()
  if (!CONTACT_TYPES.has(contactType)) {
    throw new OptInError('Please choose whether you are selling or buying.')
  }

  const name = (form.get('name') ?? '').trim()

  return {
    phone: normalised,
    name: name ? name.slice(0, 120) : null,
    contactType: contactType as OptInSubmission['contactType'],
    consented: true,
  }
}

/**
 * Builds the evidence note stored against the opt-in.
 *
 * This string is the answer to "prove they agreed". It records what they were
 * shown, when, and from where — the request's own metadata rather than
 * anything the submitter could type, because evidence a user can author is not
 * evidence.
 */
export function evidenceNote(request: Request, at: string): string {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown ip'
  const country = request.headers.get('cf-ipcountry') ?? '??'
  const agent = (request.headers.get('user-agent') ?? 'unknown').slice(0, 120)
  return [
    `web opt-in form, ${at}`,
    `ip ${ip} (${country})`,
    `ua ${agent}`,
    'consent checkbox ticked, unchecked by default',
  ].join(' | ')
}

const PAGE_STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --panel: #fff; --text: #14161a; --muted: #5c6370;
    --line: #dfe3e8; --accent: #1f7a44; --danger: #c8372d; --on-accent: #fff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a; --panel: #1c1f25; --text: #e8eaed; --muted: #9aa2ad;
      --line: #2c313a; --accent: #5ec98a; --danger: #f0796b; --on-accent: #0d1117;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; background: var(--bg); color: var(--text);
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 460px; margin: 0 auto; }
  .card {
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 12px; padding: 22px;
  }
  h1 { font-size: 21px; margin: 0 0 6px; }
  p.lead { color: var(--muted); margin: 0 0 18px; font-size: 15px; }
  label { display: block; font-size: 14px; margin: 14px 0 5px; font-weight: 500; }
  input[type=text], input[type=tel], select {
    width: 100%; font: inherit; color: inherit; background: var(--bg);
    border: 1px solid var(--line); border-radius: 8px; padding: 10px 11px;
  }
  .check { display: flex; gap: 10px; align-items: flex-start; margin: 18px 0 4px; }
  .check input { margin-top: 4px; width: 18px; height: 18px; flex: none; }
  .check label { margin: 0; font-weight: 400; font-size: 14px; color: var(--muted); }
  button {
    width: 100%; margin-top: 18px; font: inherit; font-weight: 600;
    background: var(--accent); color: var(--on-accent);
    border: none; border-radius: 8px; padding: 12px; cursor: pointer;
  }
  :focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
  .note { font-size: 13px; color: var(--muted); margin-top: 16px; }
  .error {
    border: 1px solid var(--danger); color: var(--danger);
    border-radius: 8px; padding: 10px 12px; margin-bottom: 16px; font-size: 14px;
  }
  .done { text-align: center; padding: 12px 0; }
  .done .tick { font-size: 40px; line-height: 1; }
`

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

/**
 * The form.
 *
 * The wording is deliberate. It names the business, says exactly what will be
 * sent and how often, and tells the person how to stop — which is both what
 * Meta's opt-in guidance asks for and what stops the first message being read
 * as spam by someone who has forgotten signing up.
 */
export function optInPageHtml(businessName: string, error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WhatsApp updates from ${escapeHtml(businessName)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
  <div class="card">
    <h1>Property updates on WhatsApp</h1>
    <p class="lead">From ${escapeHtml(businessName)}. One message when something
      matches what you are after — not a newsletter.</p>

    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}

    <form method="POST">
      <label for="name">Your name</label>
      <input id="name" name="name" type="text" autocomplete="name" placeholder="Optional">

      <label for="phone">WhatsApp number</label>
      <input id="phone" name="phone" type="tel" autocomplete="tel"
             placeholder="+971 50 123 4567" required>

      <label for="contact_type">I am</label>
      <select id="contact_type" name="contact_type">
        <option value="buyer">looking to buy</option>
        <option value="owner">looking to sell</option>
        <option value="both">both</option>
      </select>

      <div class="check">
        <input id="consent" name="consent" type="checkbox" value="yes" required>
        <label for="consent">
          Yes, ${escapeHtml(businessName)} may message me on WhatsApp about
          properties. I can reply STOP at any time to stop receiving them.
        </label>
      </div>

      <button type="submit">Sign me up</button>
    </form>

    <p class="note">We record the date and time of this consent. Reply STOP to any
      message and you will not hear from us again.</p>
  </div>
</main>
</body>
</html>`
}

export function optInDoneHtml(businessName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>You're on the list</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
  <div class="card done">
    <div class="tick" role="img" aria-label="Done">&#10003;</div>
    <h1>You're on the list</h1>
    <p class="lead">${escapeHtml(businessName)} will message you on WhatsApp when
      something matches. Reply STOP at any time.</p>
  </div>
</main>
</body>
</html>`
}
