# CV — filled fields

The two blanks in `Ashraf_Abbas_CV_Data_Operations.pdf`, filled. Paste these
into the existing document so its formatting is preserved.

Every claim is checkable against the repositories. Nothing is aspirational.

---

## 1. Header line

Replace `[ GitHub — add your profile URL ]` with:

```
github.com/Ash01512
```

---

## 2. TECHNICAL PROJECTS

Replace the whole `[ FILL THIS IN — see the notes... ]` block with:

---

**Job Tracker Agent** | Independent Project | 2026

- A Cloudflare Worker serving a JSON API and dashboard over a Postgres database
  that scores incoming roles against my CV, queues them for review, and records
  each application so daily and per-day application counts stay accurate.
- Row-level security is enabled on every table with no policies, so the public
  key reads nothing and the Worker holds the service-role key that bypasses RLS.
  That makes the Worker itself the security boundary: every API route requires a
  shared token and a missing token fails closed, rather than leaving the database
  open to anyone who finds the URL.
- Chose to keep submission a human action. The job board's API exposes search and
  read only, so an "auto-apply" would have reported applications that were never
  sent; the apply endpoint records what the user actually submits and rejects
  duplicates with a 409 so the count cannot inflate.
- Stack: TypeScript, Cloudflare Workers, Supabase (Postgres, PostgREST), Vitest.
  147 tests, no network required, run in CI on every push and pull request.
- github.com/Ash01512/gbrain-my-personal-agent

**1099-INT Check** | Independent Project | 2026

- Landing page for extension filers checking 1099-INT interest forms against
  their IRS Wage and Income Transcript before the 15 October deadline.
- Stack: Cloudflare Workers, HTML.
- github.com/Ash01512/1099-int-check

---

## Before you send it

0. **The repository URL above is the one that resolves today.** If you rename
   `gbrain-my-personal-agent` to `job-tracker-agent` in GitHub Settings, change
   this line and the Worker README to match — a CV link that 404s costs more
   than an unfashionable repository name.
1. **Job Tracker is deployed** as of 2026-08-20, at
   `job-tracker-worker.ashabbas-2023.workers.dev`, with all three secrets set
   and `/api/health` returning `ok: true`. "Deployed" is now accurate. The
   bullet still links the repository rather than the Worker, which is the right
   call: the Worker requires a token to show anything, so a reviewer clicking it
   would see a 401 and conclude it was broken.
2. **1099-INT is missing its engineering-decision bullet.** The other entry has
   one and it is the bullet that gets you asked about the work in an interview.
   Add one line: a real choice you made and why. It is your project and your
   decision to describe — writing it for you would put words in your mouth that
   you would then have to defend.
3. **Both entries must be explainable end to end without help.** That is the
   template's own bar. If any bullet above is not something you could talk
   through for five minutes, cut it.
