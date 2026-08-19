# TECHNICAL PROJECTS — draft for CV

Paste-ready replacement for the `[ FILL THIS IN ]` block in
`Ashraf_Abbas_CV_Data_Operations.pdf`. Follows the format the CV template asks
for: what it does in one line, one real engineering decision and why, then the
stack and the URL.

Every claim below is checkable against the repository. Nothing is aspirational.

---

**Job Tracker — Application Pipeline** | Independent Project | 2026

- A Cloudflare Worker serving a JSON API and dashboard over a Postgres database
  that tracks job applications, CV versions, and cover letters through a
  seven-stage pipeline from saved to offer.
- Row-level security is enabled on every table with no policies, so the public
  key reads nothing and the Worker has to hold the service-role key that bypasses
  RLS. That makes the Worker itself the security boundary: every API route
  requires a shared token, and a missing token fails closed rather than leaving
  the database exposed to anyone who finds the URL.
- Stack: TypeScript, Cloudflare Workers, Supabase (Postgres, PostgREST), Vitest.
  39 tests, no network required.
- https://github.com/Ash01512/job-tracker-agent

---

**1099-INT Check** | Independent Project | 2026

<!--
PENDING VERIFICATION — do not paste this entry until the two lines below are
confirmed against the repository. The one-liner is taken from the repo's own
description; the engineering-decision line is deliberately blank because the
code has not been read.
-->

- Landing page for extension filers checking 1099-INT interest forms against
  their IRS Wage and Income Transcript before the 15 October deadline.
- `[ engineering decision — pending: needs one real choice from the code and why ]`
- Stack: Cloudflare Workers, HTML.
- https://github.com/Ash01512/1099-int-check

---

## Before this goes in the CV

1. **Do not write "deployed" for Job Tracker yet.** It is committed and tested,
   not deployed. The CV template asks for projects that are "deployed or
   committed" — committed is true today, deployed is not. Claiming a live
   deployment that a reviewer cannot reach is worse than claiming nothing.
2. **Fill the GitHub URL in the CV header** — it currently reads
   `[ GitHub — add your profile URL ]`. It is https://github.com/Ash01512
3. **Finish the 1099-INT entry** once the engineering decision is confirmed.
   Two real projects beat six aspirational ones, but a half-filled entry reads
   worse than one complete one.
