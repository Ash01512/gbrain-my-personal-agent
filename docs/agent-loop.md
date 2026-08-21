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

Two tiers, because the countries are not interchangeable — see the eligibility
axis below. The split is what keeps the queue from filling with roles that
cannot hire him.

**Tier A — no sponsorship needed.** UAE (`AE`) and Saudi Arabia (`SA`). Golden
Visa means he can start in the UAE immediately, and GCC mobility makes KSA a
short step. Run every track:

| Track | Query |
| --- | --- |
| AI in operations | `AI operations data` |
| Applied AI / asset | `machine learning predictive maintenance` |
| AI governance | `AI governance risk compliance` |
| AI delivery | `AI solutions engineer` |
| Asset data | `asset management data analyst` |
| Operations data | `operations data analyst` |
| Facilities leadership | `head of facilities management` |
| Energy analytics | `energy manager analytics` |

Locations: Dubai, Abu Dhabi, Sharjah, Riyadh. Plus `remote` in each country.

**Tier B — sponsorship required.** US, Canada (`CA`), Australia (`AU`), UK
(`GB`), Ireland (`IE`), Singapore (`SG`). Only the AI tracks, because a
facilities role will never clear the sponsorship bar — no employer sponsors a
visa for a skill available locally. Run:

| Track | Query |
| --- | --- |
| AI in operations | `AI operations visa sponsorship` |
| AI governance | `AI governance risk` |
| Applied AI / asset | `machine learning asset management` |

Locations: `remote` first in every Tier B country — a remote-global role is the
one shape that sidesteps sponsorship entirely. Then the main hub only: New York,
Toronto, Sydney, London, Dublin, Singapore.

## The scoring rubric

Additive, 0–10. Every component points at something checkable in the posting, so
a score can be argued with — which is the only kind of score worth keeping.

**Domain fit (0–4)** — the one that matters most.

| Score | Anchor |
| --- | --- |
| 4 | The intersection he actually owns: AI, ML or analytics **applied to** operations, assets, maintenance or energy. Also AI governance, risk or assurance — CRISC plus 12 years of regulated operations is a genuinely uncommon pairing |
| 3 | AI solutions, implementation or delivery where domain understanding and stakeholder work outweigh model building; or asset/operations data roles with a named analytics remit |
| 2 | General data analyst or data operations with an AI adjacency; facilities or asset leadership with reporting as a named responsibility |
| 1 | Roles requiring production ML at scale, MLOps depth, or a research record — **he does not have these**, and a rubric that pretends otherwise wastes his time and an employer's |
| 0 | Unrelated, or facilities/engineering with no data angle |

The band-1 line is the honest part. Two shipped side projects and an Oracle
GenAI certificate make him credible for applying AI to a domain he knows cold.
They do not make him a competitive ML engineer, and applying as one converts at
zero while costing the same effort.

**Seniority (0–2)**

| Score | Anchor |
| --- | --- |
| 2 | Head / Manager / Lead with budget, vendor or team ownership — matches 12 years and current scope |
| 1 | Senior individual contributor, or Assistant/Deputy Manager |
| 0 | Entry level, or a Director/VP role wanting 20+ years |

**Location and eligibility (0–2)**

Scored on *who can actually hire him*, not on where the office is. He is a
Sudanese national holding a UAE Golden Visa: no permission needed in the UAE,
and needing sponsorship in six of the eight target countries. A rubric that
scored London the same as Dubai would fill the queue with roles that reject him
at the work-authorisation question, which is a slower and more demoralising way
of finding out.

| Score | Anchor |
| --- | --- |
| 2 | UAE — Golden Visa, available immediately, no employer cost. Or remote-global with no work-location restriction |
| 1.5 | KSA or elsewhere in the GCC — routine sponsorship, short relocation |
| 1 | US, Canada, Australia, UK, Ireland or Singapore where the posting **explicitly** offers visa sponsorship, or the employer is a known sponsor |
| 0.5 | Those countries, sponsorship not mentioned either way — a real but long shot |
| 0 | States "must have existing right to work", "no sponsorship", or a security clearance requiring citizenship — **and this caps the total at 0** |

**Sponsorship floor: a Tier B role scoring 0.5 here is only queued if it scores
4 on domain fit.** A long shot is worth taking when the match is exceptional and
not otherwise. Without this the queue becomes fifty postings from six countries
that will never answer, and the daily count stops meaning anything.

**Compensation (0–1)**

The floor is AED 50k/month. Converting every currency to a monthly AED figure is
the only way eight countries compare, and gross-of-tax is the honest basis: UAE
pay is untaxed, so a nominally larger UK or Canadian salary can be a pay cut.

| Score | Anchor |
| --- | --- |
| 1 | States a band whose midpoint clears AED 50k/month gross (≈ USD 165k, GBP 130k, CAD 220k, AUD 245k, EUR 150k, SGD 215k per year — recompute rather than trusting these) |
| 0.5 | Not stated. The Gulf norm, and increasingly common elsewhere, so neutral rather than penalised |
| 0 | States a band below the floor |

**Signal quality (0–1)**

| Score | Anchor |
| --- | --- |
| 1 | Named employer, detailed scope, posted by the employer |
| 0.5 | Agency posting that names its client |
| 0 | Anonymous listing, or a description that is a keyword list with no scope |

**Domain floor: a role scoring under 2 on domain fit is never queued, whatever
it totals.** Location and seniority are worth four points between them, so
without this a Dubai site-engineering role at the right level reaches 6.5 and
lands in the queue — a step backwards presented as a match. Domain fit is the
only axis that answers "is this the right job"; the rest only adjust how good
an instance of it this is.

**Hard zeros**, regardless of everything above: a stated requirement for
existing work authorisation he does not have, or for citizenship or a security
clearance; commission-only or sales-quota compensation; or a required licence or
certification he does not hold. Score 0 and do not queue.

### Calibration

- **9–10** — AI or analytics applied to operations, in the UAE or remote-global,
  at the right level and employer-posted. Apply today.
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
| AI Governance Lead, bank, remote-global, band stated, employer-posted | 4 | 2 | 2 | 1 | 1 | **10** | queue + draft letter |
| Predictive Maintenance AI Lead, aviation group, Dubai, employer-posted | 4 | 2 | 2 | 0.5 | 1 | **9.5** | queue + draft letter |
| Applied AI Engineer, energy, London, sponsorship offered, band stated | 4 | 1 | 1 | 1 | 1 | **8.0** | queue + draft letter |
| AI Solutions Engineer, consultancy, Riyadh, employer-posted | 3 | 2 | 1.5 | 0.5 | 1 | **8.0** | queue + draft letter |
| AI Program Manager, logistics, Toronto, sponsorship not mentioned | 3 | 2 | 0.5 | 0.5 | 1 | 7.0 | **not queued — sponsorship floor** |
| Mechanical Site Engineer, Dubai, employer-posted | **1** | 2 | 2 | 0.5 | 1 | 6.5 | **not queued — domain floor** |
| ML Research Engineer, Singapore, "must hold existing right to work" | 1 | 1 | **0** | 1 | 1 | **0** | **not queued — hard zero** |

Three rows are there to be argued with. The **Toronto** row clears the numeric
threshold at 7.0 and is still dropped: good role, plausible seniority, and no
stated sponsorship — a long shot that only earns a slot at domain 4. The
**Dubai site engineer** clears it too and is a step backwards, because location
and seniority are worth four points before the job itself is considered. The
**Singapore** row is the honest one about him: a research role is a 1 on domain
whatever else it offers, and the work-authorisation line makes it a hard zero
twice over.

### What the agent sends

For the first row, the exact `POST /api/queue` body:

```json
{
  "company": "Example Bank",
  "role": "AI Governance Lead",
  "location": "Remote — global",
  "job_url": "https://www.indeed.com/viewjob?jk=abc123",
  "source": "indeed",
  "match_score": 10,
  "match_rationale": "4 domain — owns model risk and assurance for deployed AI, and CRISC plus 12 years of regulated operations is the exact pairing asked for; 2 seniority — Lead, owns the control framework; 2 remote-global, no work-location restriction so no sponsorship question; 1 comp band midpoint clears the floor; 1 employer-posted with full scope"
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
going up. Eight countries is what makes round-the-clock cadence earn its keep
rather than just sound thorough: Singapore posts while Dubai sleeps, and the US
west coast posts while both do. There is no hour of the day when every target
market is quiet, so there is no run that is reliably wasted.

The dedupe is what makes this safe to run continuously. `job_url` carries a
unique index and the Worker maps the resulting `23505` to a 409, so a role found
on six consecutive runs is queued once. Frequency costs API calls, never
duplicate entries.

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

1. Search Indeed across the tracks in that document, both tiers. Tier A is
   country_code AE (Dubai, Abu Dhabi, Sharjah) and SA (Riyadh), plus remote in
   each. Tier B is US, CA, AU, GB, IE and SG — run remote first in every one of
   them, then the single named hub city, and only the AI tracks.
2. For each plausible result, call get_job_details and score it 0-10 against the
   rubric. Discard anything under 6 without comment. Apply both floors: domain
   fit under 2 is never queued whatever it totals, and a Tier B role with no
   stated sponsorship is only queued at domain fit 4. Read the posting for the
   work-authorisation line specifically — "must have existing right to work" is
   a hard zero, not a detail to sort out later.
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
