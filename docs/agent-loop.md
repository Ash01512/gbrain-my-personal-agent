# The agent loop

The scheduled half of the job tracker. Every four hours it searches, scores each
role against the CV, drafts a letter for the strong ones, and files them in the
queue. By the time you look, the reading is done.

This is the component `docs/designs/job-tracker-agent.md` calls "the remaining
piece". It answers that document's Open Question 1 (scoring rubric) and
Question 2 (volume), because a score with no written rubric is unfalsifiable and
a queue with no cap becomes another thing you ignore.

## What it does, and where it stops

Each run:

1. Reads `JOB_TRACKER_URL` and `JOB_TRACKER_TOKEN` from the environment. If
   either is missing, it says so and stops — no searching, no wasted run.
2. `GET /api/health`. A 503 means a Worker secret is unset; it reports which and
   stops rather than searching into a void.
3. Searches Indeed across the tracks below.
4. Pulls full details for anything plausible, scores it 0–10 against the rubric,
   and discards anything under 6 without comment.
5. Drafts a cover letter for anything scoring 8+.
6. `POST /api/queue` for each survivor. A role already queued comes back 409 from
   the `job_url` unique index; that is the dedupe working, not an error.
7. Reports: searched, scored, queued, skipped-as-duplicate, and the single best
   role found.

**It never applies.** The Indeed connector has four tools — `search_jobs`,
`get_job_details`, `get_company_data`, `get_resume` — and none of them submits an
application; `search_jobs`' own documentation says the apply link exists "so the
user can click the job titles to apply". There is no endpoint to automate. A loop
that claimed otherwise would increment a counter for applications that were never
sent, which is the one failure this project is built to prevent.

The Worker enforces this rather than trusting the prompt: `parseQueueItem` forces
`status` to `saved` and strips `applied_on`, so even a misbehaving agent cannot
mark anything as applied.

## Search tracks

Run each per cycle, UAE, `country_code: AE`:

| Track | Query |
| --- | --- |
| Asset data | `asset management data analyst` |
| Maintenance analytics | `predictive maintenance reliability engineer` |
| Facilities leadership | `head of facilities management` |
| CMMS / CAFM | `CMMS CAFM manager` |
| Energy analytics | `energy manager analytics` |
| Operations data | `operations data analyst` |

Locations: Dubai, Abu Dhabi, Sharjah. Also run `remote` with `country_code: AE`.

## The scoring rubric

Additive, 0–10. Every component points at something checkable in the posting, so
a score can be argued with — which is the only kind of score worth keeping.

**Domain fit (0–4)** — the one that matters most.

| Score | Anchor |
| --- | --- |
| 4 | Asset/operations **data** is the core of the role: names CMMS/CAFM data, reliability engineering, condition-based or predictive maintenance, or energy analytics as a primary responsibility |
| 3 | Facilities or asset management leadership where analytics, KPIs or reporting is a named responsibility, not a nice-to-have |
| 2 | Facilities or operations management with no data component |
| 1 | Adjacent engineering — project, mechanical, MEP — with no asset or data angle |
| 0 | Unrelated |

**Seniority (0–2)**

| Score | Anchor |
| --- | --- |
| 2 | Head / Manager / Lead with budget, vendor or team ownership — matches 12 years and current scope |
| 1 | Senior individual contributor, or Assistant/Deputy Manager |
| 0 | Entry level, or a Director/VP role wanting 20+ years |

**Location and eligibility (0–2)**

| Score | Anchor |
| --- | --- |
| 2 | UAE, onsite or hybrid — or remote with UAE eligibility |
| 1 | Elsewhere in the GCC, relocation plausible |
| 0 | Outside the GCC with no remote option — **and this caps the total at 0** |

**Compensation (0–1)**

| Score | Anchor |
| --- | --- |
| 1 | States AED 50k+/month, or a band whose midpoint clears it |
| 0.5 | Not stated — the UAE norm, so neutral rather than penalised |
| 0 | States below AED 50k/month |

**Signal quality (0–1)**

| Score | Anchor |
| --- | --- |
| 1 | Named employer, detailed scope, posted by the employer |
| 0.5 | Agency posting that names its client |
| 0 | Anonymous listing, or a description that is a keyword list with no scope |

**Domain floor: a role scoring under 2 on domain fit is never queued, whatever
it totals.** Location and seniority are worth four points between them, so
without this a Dubai site-engineering role at the right level reaches 6.0 and
lands in the queue — a step backwards presented as a match. Domain fit is the
only axis that answers "is this the right job"; the rest only adjust how good
an instance of it this is.

**Hard zeros**, regardless of everything above: outside the GCC with no remote
option; commission-only or sales-quota compensation; a stated nationality or
visa requirement he does not meet; or a required licence or certification he
does not hold. Score 0 and do not queue.

### Calibration

- **9–10** — asset data leadership in the UAE at the right level, employer-posted.
  Apply today.
- **8** — strong on domain and seniority, one soft spot. Drafts a letter.
- **6–7** — real but imperfect. Queued for a decision, no letter.
- **Under 6** — discarded silently. Not queued, not counted.

Write the rationale as the *reason for the number*, not a summary of the
posting: "4 domain — owns the CMMS data model; 2 seniority — manages three
vendors; 2 UAE onsite; 0.5 comp not stated; 1 employer-posted" beats "Great fit
for facilities role."

### Worked examples

Illustrative, not real postings — they exist so the rubric can be argued with
before it is trusted, and so a reviewer can see what the agent actually sends.

| Posting | Domain | Sen | Loc | Comp | Sig | Total | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Asset Data Lead, aviation group, Dubai, employer-posted, owns the CMMS data model | 4 | 2 | 2 | 0.5 | 1 | **9.5** | queue + draft letter |
| Reliability Engineer, utility, Abu Dhabi, condition-based maintenance, AED 55k stated | 4 | 1 | 2 | 1 | 1 | **9.0** | queue + draft letter |
| Head of Facilities, retail group, Sharjah, KPI reporting named | 3 | 2 | 2 | 0.5 | 0.5 | **8.0** | queue + draft letter |
| Facilities Manager, no data component, Dubai, agency posting | 2 | 2 | 2 | 0.5 | 0.5 | **7.0** | queue, no letter |
| Mechanical Site Engineer, Dubai, employer-posted | **1** | 2 | 2 | 0.5 | 1 | 6.5 | **not queued — domain floor** |
| Asset Data Manager, Riyadh, no remote | 4 | 2 | 1 | 0.5 | 1 | **8.5** | queue, no letter |
| Asset Analytics Lead, London, no remote | 4 | 2 | **0** | 1 | 1 | **0** | **not queued — hard zero** |

The fifth row is the one to check the floor against: it clears the numeric
threshold and is still wrong, because Dubai plus the right seniority is worth
four points before the job itself is considered.

### What the agent sends

For the first row, the exact `POST /api/queue` body:

```json
{
  "company": "Emirates Group",
  "role": "Asset Data Lead",
  "location": "Dubai, UAE",
  "job_url": "https://ae.indeed.com/viewjob?jk=abc123",
  "source": "indeed",
  "match_score": 9.5,
  "match_rationale": "4 domain — owns the CMMS data model and the condition-based maintenance regime; 2 seniority — Head-level, owns vendor budget; 2 UAE onsite; 0.5 comp not stated; 1 employer-posted with full scope"
}
```

No `status`, no `applied_on` — and if the agent sent them anyway, the Worker
strips them. See `test/agent-contract.test.ts`, which drives these exact
payloads through the real handler.

## Volume

At most **10 queued per run**, best first. If more than 10 clear the bar, queue
the top 10 and say how many were dropped — a silently truncated queue reads as
"that's all there was."

## Configuration

Two environment variables, set in the Claude Code environment settings — the same
place as `GBRAIN_DATABASE_URL`. Neither belongs in this repository.

| Variable | Value |
| --- | --- |
| `JOB_TRACKER_URL` | The deployed Worker origin, no trailing slash |
| `JOB_TRACKER_TOKEN` | The same `API_TOKEN` set on the Worker |

The token is the Worker's front door and the Worker holds a service-role key, so
treat it accordingly: environment settings only, never a commit, never a prompt.

## Schedule

Every four hours — six runs a day, so a posting is seen within four hours of
going up. UAE hiring activity clusters into Sunday–Thursday business hours, so
most overnight runs will find nothing new and cost almost nothing; that is the
price of low latency on the ones that do.

To change the cadence or pause it, edit the Routine in Claude settings rather
than this file. This file is the spec; the Routine is the thing that runs.

## The run prompt

The Routine carries this verbatim. Kept here so it is reviewable, diffable, and
does not exist only inside a settings page.

```text
Job tracker — scheduled discovery run.

Read JOB_TRACKER_URL and JOB_TRACKER_TOKEN from the environment. If either is
unset, report "job tracker not configured: <which>" and stop. Do not search.

GET $JOB_TRACKER_URL/api/health. If it is not 200, report the response and stop
— a 503 names the Worker variable that is unset.

Then, following docs/agent-loop.md in the repository for the search tracks and
the scoring rubric:

1. Search Indeed across every track in that document, for Dubai, Abu Dhabi and
   Sharjah, plus remote with country_code AE.
2. For each plausible result, call get_job_details and score it 0-10 against the
   rubric. Discard anything under 6 without comment.
3. For anything scoring 8 or above, draft a cover letter grounded in specifics
   from the CV in docs/cv-technical-projects.md and the profile in the design
   doc. No generic praise: name the employer's actual problem and the specific
   experience that meets it.
4. POST each survivor to $JOB_TRACKER_URL/api/queue with an Authorization:
   Bearer $JOB_TRACKER_TOKEN header and a JSON body of company, role, location,
   job_url, source, match_score, match_rationale. The rationale is the arithmetic
   of the score, not a summary of the posting. Cap at 10 per run, best first.
   A 409 means the role is already queued — count it and move on, it is the
   dedupe working.
5. Report one short paragraph: how many were searched, scored, queued and
   already-known, the single best role with its score, and how many cleared the
   bar but were dropped by the cap. If nothing cleared the bar, say that in one
   line.

You must never mark anything applied, and never set applied_on. The human presses
submit. The Worker enforces this regardless of what this prompt says, and that is
deliberate.
```
