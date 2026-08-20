// Campaign execution: the part that runs on a schedule with nobody present.
//
// Everything here is written on the assumption that no one will read the
// result until something has already gone wrong. That changes the defaults:
// a step that cannot be completed safely stops rather than guessing, a
// contact that cannot be personalised is skipped rather than sent a message
// with a hole in it, and the pace is capped in two independent places so a
// bug in one does not empty the list into WhatsApp in a single tick.
//
// The selection and rendering logic is pure so it can be tested without a
// database; `runCampaign` in index.ts does the I/O around it.

import { hasProvenContact, unsupportedClaims, type GateLimits } from './consent'
import type { Campaign, Contact, MessageTemplate, Property } from './schema'

export interface Personalisation {
  variables: string[]
  /** Present when this contact cannot be personalised and must be skipped. */
  skip?: string
}

/**
 * Resolves a campaign's `variable_sources` against one contact and property.
 *
 * Source strings are `contact.<column>` or `property.<column>`. Anything else,
 * or a value that is missing or blank, skips the contact.
 *
 * Skipping is the point. A greeting that renders as "Hi ," reads as a botched
 * mail-merge, and the recipient's response to a botched mail-merge is Block —
 * which is the signal Meta rates the number on. One unpersonalisable contact
 * is worth far less than the number's standing.
 */
export function personalise(
  campaign: Pick<Campaign, 'variable_sources'>,
  contact: Contact,
  property: Property | null,
): Personalisation {
  const variables: string[] = []

  for (const source of campaign.variable_sources ?? []) {
    const [scope, column] = String(source).split('.', 2)
    if (!column) return { variables: [], skip: `variable source "${source}" is malformed` }

    let value: unknown
    if (scope === 'contact') {
      value = (contact as unknown as Record<string, unknown>)[column]
    } else if (scope === 'property') {
      if (!property) return { variables: [], skip: `campaign has no property for "${source}"` }
      value = (property as unknown as Record<string, unknown>)[column]
    } else {
      return { variables: [], skip: `unknown variable scope "${scope}"` }
    }

    if (value === null || value === undefined || String(value).trim() === '') {
      return { variables: [], skip: `${source} is empty for this contact` }
    }
    variables.push(String(value))
  }

  return { variables }
}

/**
 * How many messages this campaign may still send today.
 *
 * Deliberately the smaller of the daily budget and one batch. Two independent
 * caps, checked here and enforced again by the database's once-per-contact
 * index, because the failure being defended against is an unattended loop
 * sending the entire list.
 */
export function allowanceForRun(
  campaign: Pick<Campaign, 'daily_cap' | 'batch_size'>,
  sentToday: number,
): number {
  const remainingToday = Math.max(0, campaign.daily_cap - sentToday)
  return Math.min(remainingToday, campaign.batch_size)
}

/** Per-campaign limits. `oncePerContact` is not configurable: it is the policy. */
export function limitsForCampaign(base: {
  maxPerContact: number
  windowDays: number
}): GateLimits {
  return { ...base, oncePerContact: true }
}

export interface RenderedDraft {
  contact: Contact
  variables: string[]
  body: string
}

/**
 * Builds the message for one contact, or explains why it cannot be built.
 *
 * The claim check runs here as well as in the gate. The gate is what refuses
 * the send; this is what stops a doomed row being written on every tick — and
 * it puts the reason in the campaign's run report, where the person who wrote
 * the template will actually see it.
 */
export function draftFor(
  campaign: Campaign,
  template: Pick<MessageTemplate, 'body'>,
  contact: Contact,
  property: Property | null,
  render: (body: string, values: string[]) => string,
): RenderedDraft | { skip: string } {
  const personalised = personalise(campaign, contact, property)
  if (personalised.skip) return { skip: personalised.skip }

  let body: string
  try {
    body = render(template.body, personalised.variables)
  } catch (error) {
    return { skip: error instanceof Error ? error.message : 'could not render template' }
  }

  if (!hasProvenContact(contact)) {
    const claims = unsupportedClaims(body)
    if (claims.length > 0) {
      return {
        skip: `template claims a past interaction this contact never had: ${claims.join('; ')}`,
      }
    }
  }

  return { contact, variables: personalised.variables, body }
}

export interface RunReport {
  campaign: string
  considered: number
  sent: number
  blocked: number
  skipped: number
  failed: number
  /** Why contacts were skipped or blocked, deduped, for the run log. */
  reasons: Record<string, number>
  stoppedBecause?: string
}

export function emptyReport(name: string): RunReport {
  return {
    campaign: name,
    considered: 0,
    sent: 0,
    blocked: 0,
    skipped: 0,
    failed: 0,
    reasons: {},
  }
}

export function noteReason(report: RunReport, reason: string): void {
  // Truncated: reasons become object keys, and an unbounded string from a
  // template error would make the report unreadable and the log entry huge.
  const key = reason.slice(0, 120)
  report.reasons[key] = (report.reasons[key] ?? 0) + 1
}

/** PostgREST filters selecting a campaign's audience. */
export function audienceFilters(campaign: Campaign): Record<string, string> {
  const filters: Record<string, string> = {
    // The only contacts that can legally be messaged. Applied as a query
    // filter as well as a gate check so an unattended run never even loads
    // the people it must not contact.
    opt_in_state: 'eq.opted_in',
  }
  if (campaign.audience_contact_type) {
    filters.contact_type = `eq.${campaign.audience_contact_type}`
  }
  if (campaign.audience_language) {
    filters.language = `eq.${campaign.audience_language}`
  }
  return filters
}
