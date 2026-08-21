# CV — filled fields

The two blanks in `Ashraf_Abbas_CV_Data_Operations.pdf`, filled. Paste these
into the existing document so its formatting is preserved.

Every claim is checkable against the repositories. Nothing is aspirational.

---

## 1. Header line

Replace `[ LinkedIn ]  |  [ GitHub — add your profile URL ]` with:

```
linkedin.com/in/ashraf-abbas  |  github.com/Ash01512
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
  159 tests, no network required, run in CI on every push and pull request.
- github.com/Ash01512/gbrain-my-personal-agent

**1099-INT Check** | Independent Project | 2026

- A Cloudflare Pages site and signup flow for US extension filers checking
  1099-INT interest forms against their IRS Wage and Income Transcript before
  the 15 October deadline.
- Separated a rate limiter's IP hash from the mailing-list table it was stored
  beside: a value needed for sixty seconds was being retained indefinitely next
  to an email address. Hashes moved to their own table that purges rows older
  than two minutes, and inserts now run through a SECURITY DEFINER function, so
  the public key holds no direct write on the signups table at all.
- Stack: JavaScript, Cloudflare Pages, Supabase, node:test.
- github.com/Ash01512/1099-int-check

## Repositories deliberately left off

Audited on 2026-08-21. Two looked like CV material and did not survive the
check. Both would have been found by any interviewer who clicked.

- **InsideTradeView** — described on GitHub as "Agentic Financial AI Platform".
  The repository is **empty**: no commits, no files. The description is the
  whole project. Either build it or delete the repository; an empty repo with an
  ambitious name is worse than no repo, because the description reads as a claim.
- **-AI-Governance-Framework** — a real and impressive project, but not his. The
  history carries fifteen commits from Ruslan Magana Vsevolodovna (IBM) and
  three from this account, and those three change 24 lines: renaming the model
  provider from IBM Granite to gpt-o4 across a README, two docs and one source
  file. The fourth commit adds an unrelated 3,320-line YouTube-metadata Colab
  notebook to the same repository. Listing this as a personal project invites an
  interviewer to run `git log`, and `git log` tells a different story than the
  CV does. If the framework is worth citing, cite it as what it is: a
  contribution to someone else's open-source project.

- **Introducing-Generative-AI-with-AWS** — all thirteen commits are by Tafadzwa
  Mary-Anne Chigwada. None are his. It is someone else's repository sitting in
  his account.
- **-ExamProCo-aws-bootcamp-cruddur-2023** — empty, zero commits. The second
  empty repository in the account, and a near-duplicate name of the bootcamp repo
  that *is* real, which makes the real one look worse by association.
- **aws-hybrid-cloud-dev-2024** — 135 files in a single commit. A course material
  dump, not work.

### The full account, audited 2026-08-21

Ten repositories. All ten were checked — commit count, authorship, file count —
rather than judged by name:

| Repository | Verdict |
| --- | --- |
| `gbrain-my-personal-agent` | **On the CV.** Job Tracker Agent |
| `1099-int-check` | **On the CV.** 2,394 lines, own test suite |
| `aws-bootcamp-cruddur-2023` | Real, ~60 own commits, but guided coursework — removed from the CV at his request |
| `Ash01512` | Profile README. Not a project — but see below |
| `-AI-Governance-Framework` | Someone else's, 24 own lines |
| `InsideTradeView` | Empty |
| `-ExamProCo-aws-bootcamp-cruddur-2023` | Empty |
| `Introducing-Generative-AI-with-AWS` | Someone else's, zero own commits |
| `aws-hybrid-cloud-dev-2024` | Single-commit course dump |
| `playground-Scrubbing-Github-History...` | Private, a learning exercise |

There is no fourth Claude-built project. The two that exist were both created in
August 2026 and are both already listed.

### The profile README contradicts the project

`Ash01512/README.md` is the first thing a recruiter reads, and it describes Job
Tracker as pulling "from two job-board APIs on a daily cron", filtering against
"two independent search profiles", with "per-source and per-profile failure
isolation". None of that is what was built: one board, one profile, a four-hourly
scheduled Claude session, and the failure isolation described does not exist.

It reads as a spec that was never revised after the design changed. An
interviewer who reads the profile and then the repository finds the mismatch
immediately, and the generous reading — stale text — is not the first one that
occurs to them. Rewrite it to match `README.md` in this repository.

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
2. **Both entries must be explainable end to end without help.** That is the
   template's own bar. If any bullet above is not something you could talk
   through for five minutes, cut it.
