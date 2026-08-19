// The dashboard's pure helpers, evaluated from the exact source the page
// ships rather than a copy that could drift out of step with it.

import { describe, expect, it } from 'vitest'
import { CLIENT_HELPERS, dashboardHtml } from '../src/ui'

const helpers = new Function(
  `${CLIENT_HELPERS}; return { esc, safeUrl, scoreCell }`,
)() as {
  esc: (v: unknown) => string
  safeUrl: (v: unknown) => string | null
  scoreCell: (v: unknown) => string
}

describe('esc', () => {
  it('encodes every character that could break out of markup', () => {
    expect(helpers.esc('<img src=x onerror="a">')).toBe(
      '&lt;img src=x onerror=&quot;a&quot;&gt;',
    )
    expect(helpers.esc("it's")).toBe('it&#39;s')
    expect(helpers.esc('&amp;')).toBe('&amp;amp;')
  })

  it('renders nullish values as empty, not as "null"', () => {
    expect(helpers.esc(null)).toBe('')
    expect(helpers.esc(undefined)).toBe('')
  })
})

describe('safeUrl', () => {
  it('passes ordinary job links through', () => {
    expect(helpers.safeUrl('https://jobs.example/1?x=1#a')).toBe('https://jobs.example/1?x=1#a')
    expect(helpers.safeUrl('http://jobs.example/1')).toBe('http://jobs.example/1')
  })

  it('rejects every scheme that would execute on this origin', () => {
    // job_url comes from third-party postings the matching agent ingests, and
    // the page puts it in an href and a window.open() the human is told to
    // click. Script running here can read the API token out of localStorage,
    // and that token fronts a service-role key that bypasses RLS.
    for (const hostile of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      '  javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://w/1234',
    ]) {
      expect(helpers.safeUrl(hostile)).toBeNull()
    }
  })

  it('rejects anything that is not a parseable absolute URL', () => {
    for (const bad of ['', 'not a url', '/relative', null, undefined, 42, {}]) {
      expect(helpers.safeUrl(bad)).toBeNull()
    }
  })

  it('escaping alone would not have caught this', () => {
    // esc() leaves the scheme intact — it only encodes &<>"' — and the apply
    // button reads its URL back from `dataset`, which decodes entities. The
    // scheme check is what closes it, at the sink as well as at the door.
    expect(helpers.esc('javascript:alert(1)')).toBe('javascript:alert(1)')
  })
})

describe('scoreCell', () => {
  it('renders a zero score as a score, not as "no score"', () => {
    // A falsy check here would hide every zero-scored row's score, which is
    // the one score that most needs to be visible.
    expect(helpers.scoreCell(0)).toContain('0.0')
    expect(helpers.scoreCell(9.5)).toContain('9.5')
  })

  it('renders a missing score as a placeholder, distinct from zero', () => {
    for (const missing of [null, undefined]) {
      expect(helpers.scoreCell(missing)).toContain('score none')
      expect(helpers.scoreCell(missing)).not.toContain('0.0')
    }
  })

  it('tiers the score so the eye can sort before reading', () => {
    expect(helpers.scoreCell(8)).toContain('score high')
    expect(helpers.scoreCell(7.9)).toContain('score mid')
    expect(helpers.scoreCell(5.9)).toContain('score low')
  })

  it('says what the score is out of', () => {
    expect(helpers.scoreCell(8.5)).toContain('/10')
  })
})

describe('the page ships the helpers it calls', () => {
  const html = dashboardHtml()

  it('embeds the guard rather than defining a second copy', () => {
    expect(html).toContain('function safeUrl(value)')
    expect(html.match(/function safeUrl\(/g)).toHaveLength(1)
  })

  it('does not pass noopener to window.open', () => {
    // With the feature string, window.open returns null unconditionally —
    // indistinguishable from a blocked popup, so the guard below would fire on
    // every apply and no application would ever be recorded. Clearing `opener`
    // on the returned handle gives the same protection and keeps the answer.
    expect(html).toContain("window.open(target, '_blank')")
    expect(html).toContain('opened.opener = null')
    expect(html).not.toContain("'noopener')")
  })

  it('will not record an application the user never saw', () => {
    // The POST must be inside the branch where a tab actually opened.
    const openIndex = html.indexOf('const opened = window.open')
    const guardIndex = html.indexOf('Popup blocked')
    const postIndex = html.indexOf("'/apply', { method: 'POST' }")
    expect(openIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeGreaterThan(openIndex)
    expect(postIndex).toBeGreaterThan(guardIndex)
  })

  it('checks the scheme at both sinks', () => {
    // The href is built from the checked value, and window.open re-checks
    // because dataset is read back decoded.
    expect(html).toContain('const url = safeUrl(r.job_url)')
    expect(html).toContain('safeUrl(e.target.dataset.url)')
    expect(html).not.toContain('window.open(e.target.dataset.url')
  })
})
