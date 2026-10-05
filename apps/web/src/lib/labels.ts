import type {
  CapabilityLevel,
  CapabilityName,
  ConfirmationStatus,
  Freshness,
  JobOperation,
  JobState,
  JobType,
  PriceKind,
  ProviderReadiness,
  PurchasePath,
} from '@domain-scout/contracts';

/*
 * Labels and tones for every status the UI shows. Tone drives only a small dot; the label is always
 * rendered next to it. `unresolved` statuses draw a hollow ring so they never read as positive,
 * even without color. no_record is "No record", never "Available".
 */
export type Tone = 'positive' | 'neutral' | 'caution' | 'negative' | 'muted';

export interface StatusInfo {
  label: string;
  tone: Tone;
  /** Unresolved: the source gave no definitive answer. Rendered as a ring, never a filled positive dot. */
  unresolved?: boolean;
}

export function humanize(code: string): string {
  const text = code.replace(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const REGISTRY: Record<string, StatusInfo> = {
  registered: { label: 'Registered', tone: 'neutral' },
  no_record: { label: 'No record', tone: 'positive' },
  inconclusive: { label: 'Inconclusive', tone: 'caution', unresolved: true },
  rate_limited: { label: 'Rate limited', tone: 'caution', unresolved: true },
  blocked: { label: 'Blocked', tone: 'caution', unresolved: true },
  invalid: { label: 'Invalid', tone: 'negative' },
  unsupported: { label: 'Unsupported', tone: 'muted' },
};

const PROVIDER_CHECK: Record<string, StatusInfo> = {
  available: { label: 'Available', tone: 'positive' },
  unavailable: { label: 'Unavailable', tone: 'neutral' },
  restricted: { label: 'Restricted', tone: 'negative' },
  unknown: { label: 'Unknown', tone: 'caution', unresolved: true },
};

const QUOTE: Record<string, StatusInfo> = {
  quoted: { label: 'Quoted', tone: 'positive' },
  unavailable: { label: 'Unavailable', tone: 'neutral' },
  restricted: { label: 'Restricted', tone: 'negative' },
  unsupported: { label: 'Unsupported', tone: 'muted' },
  credential_required: { label: 'Needs credentials', tone: 'muted' },
};

const AFTERMARKET: Record<string, StatusInfo> = {
  listed: { label: 'Listed', tone: 'positive' },
  not_listed: { label: 'Not listed', tone: 'neutral' },
  unsupported: { label: 'Unsupported', tone: 'muted' },
  credential_required: { label: 'Needs credentials', tone: 'muted' },
};

const NAME_CHECK: Record<string, StatusInfo> = {
  exists: { label: 'Exists', tone: 'neutral' },
  not_found: { label: 'Not found', tone: 'positive' },
  restricted: { label: 'Restricted', tone: 'negative' },
  rate_limited: { label: 'Rate limited', tone: 'caution', unresolved: true },
  error: { label: 'Error', tone: 'caution', unresolved: true },
  unsupported: { label: 'Unsupported', tone: 'muted' },
};

const DIAGNOSTIC: Record<string, StatusInfo> = {
  observed: { label: 'Observed', tone: 'neutral' },
  no_answer: { label: 'No answer', tone: 'muted' },
  error: { label: 'Error', tone: 'caution', unresolved: true },
  unreachable: { label: 'Unreachable', tone: 'caution', unresolved: true },
  timeout: { label: 'Timed out', tone: 'caution', unresolved: true },
};

const CATALOG: Record<string, StatusInfo> = {
  updated: { label: 'Updated', tone: 'positive' },
  unchanged: { label: 'Unchanged', tone: 'neutral' },
};

const BY_OPERATION: Record<JobOperation, Record<string, StatusInfo>> = {
  registry: REGISTRY,
  provider_check: PROVIDER_CHECK,
  quote: QUOTE,
  transfer: QUOTE,
  aftermarket: AFTERMARKET,
  name_check: NAME_CHECK,
  diagnostic: DIAGNOSTIC,
  catalog: CATALOG,
};

/** Known outcomes per operation, for filter menus. */
export function outcomeOptions(operation: JobOperation): { value: string; label: string }[] {
  return Object.entries(BY_OPERATION[operation]).map(([value, info]) => ({ value, label: info.label }));
}

export function outcomeStatus(operation: JobOperation, outcome: string | null, state?: string): StatusInfo {
  if (outcome === null) {
    if (state === 'running') return { label: 'Checking', tone: 'muted', unresolved: true };
    if (state === 'interrupted') return { label: 'Interrupted', tone: 'caution', unresolved: true };
    return { label: 'Pending', tone: 'muted', unresolved: true };
  }
  return (
    BY_OPERATION[operation][outcome] ??
    REGISTRY[outcome] ?? { label: humanize(outcome), tone: 'caution', unresolved: true }
  );
}

export function registryStatus(outcome: string): StatusInfo {
  return REGISTRY[outcome] ?? { label: humanize(outcome), tone: 'caution', unresolved: true };
}

export function confirmationStatus(status: ConfirmationStatus): StatusInfo {
  return PROVIDER_CHECK[status] ?? { label: humanize(status), tone: 'muted' };
}

export function nameCheckStatus(outcome: string): StatusInfo {
  return NAME_CHECK[outcome] ?? { label: humanize(outcome), tone: 'caution', unresolved: true };
}

export function diagnosticStatus(outcome: string): StatusInfo {
  return DIAGNOSTIC[outcome] ?? { label: humanize(outcome), tone: 'caution', unresolved: true };
}

export const JOB_STATE: Record<JobState, StatusInfo> = {
  queued: { label: 'Queued', tone: 'muted' },
  running: { label: 'Running', tone: 'neutral' },
  cancelling: { label: 'Cancelling', tone: 'caution' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
  completed: { label: 'Completed', tone: 'positive' },
  completed_with_errors: { label: 'Completed with unresolved', tone: 'caution', unresolved: true },
  interrupted: { label: 'Interrupted', tone: 'caution', unresolved: true },
};

export function jobStateStatus(state: string): StatusInfo {
  return JOB_STATE[state as JobState] ?? { label: humanize(state), tone: 'muted' };
}

export const JOB_TYPE: Record<JobType, string> = {
  registry_scan: 'Registry scan',
  provider_check: 'Provider check',
  quote: 'Quotes',
  aftermarket: 'Aftermarket lookup',
  transfer: 'Transfer prices',
  name_check: 'Name checks',
  diagnostics: 'Diagnostics',
  catalog_refresh: 'Catalog refresh',
  watch: 'Watch run',
};

export function jobTypeLabel(type: string): string {
  return JOB_TYPE[type as JobType] ?? humanize(type);
}

export const JOB_OPERATION: Record<JobType, JobOperation> = {
  registry_scan: 'registry',
  provider_check: 'provider_check',
  quote: 'quote',
  aftermarket: 'aftermarket',
  transfer: 'transfer',
  name_check: 'name_check',
  diagnostics: 'diagnostic',
  catalog_refresh: 'catalog',
  watch: 'registry',
};

export const FRESHNESS: Record<Freshness, StatusInfo> = {
  fresh: { label: 'Fresh', tone: 'muted' },
  stale: { label: 'Stale', tone: 'caution' },
  expired: { label: 'Expired', tone: 'caution' },
};

export const PRICE_KIND: Record<PriceKind, string> = {
  published: 'Published',
  estimated: 'Estimate',
  exact_quote: 'Exact quote',
};

export const PURCHASE_PATH: Record<PurchasePath, string> = {
  new_registration: 'New registration',
  renewal: 'Renewal',
  transfer: 'Transfer',
  aftermarket: 'Aftermarket',
};

export const READINESS: Record<ProviderReadiness, StatusInfo> = {
  ready: { label: 'Ready', tone: 'positive' },
  keyless: { label: 'Keyless', tone: 'neutral' },
  credentials_missing: { label: 'Needs credentials', tone: 'muted' },
  credentials_invalid: { label: 'Invalid credentials', tone: 'negative' },
  disabled: { label: 'Disabled', tone: 'muted' },
};

export const CAPABILITY_LEVEL: Record<CapabilityLevel, string> = {
  unsupported: 'Unsupported',
  documented: 'Documented',
  fixture_tested: 'Fixture tested',
  live_tested: 'Live tested',
};

export const CAPABILITY_NAME: Record<CapabilityName, string> = {
  purchaseLink: 'Purchase link',
  catalog: 'Catalog',
  exactCheck: 'Exact check',
  quote: 'Quote',
  transfer: 'Transfer',
  aftermarket: 'Aftermarket',
};

export const CAPABILITY_ORDER: CapabilityName[] = ['purchaseLink', 'catalog', 'exactCheck', 'quote', 'transfer', 'aftermarket'];

export const WATCH_STATE: Record<string, StatusInfo> = {
  active: { label: 'Active', tone: 'positive' },
  paused: { label: 'Paused', tone: 'muted' },
};

/** Missed runs and runs with failures are unresolved: they never read as a successful check. */
export const WATCH_RUN_STATUS: Record<string, StatusInfo> = {
  scheduled: { label: 'Scheduled', tone: 'muted' },
  running: { label: 'Running', tone: 'neutral' },
  completed: { label: 'Completed', tone: 'positive' },
  completed_with_errors: { label: 'Completed with failures', tone: 'caution', unresolved: true },
  missed: { label: 'Missed', tone: 'caution', unresolved: true },
  catch_up: { label: 'Catch-up run', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

export function watchRunStatus(status: string): StatusInfo {
  return WATCH_RUN_STATUS[status] ?? { label: humanize(status), tone: 'muted' };
}

export const NOTICE_TYPE: Record<string, string> = {
  availability_changed: 'Registry result changed',
  confirmation_changed: 'Provider confirmation changed',
  price_changed: 'Price changed',
};

/** Before/after evidence values: registry outcomes and confirmation states get their labels; amounts stay as given. */
export function evidenceStatus(kind: string, value: string): StatusInfo | null {
  if (kind === 'registry') return registryStatus(value);
  if (kind === 'confirmation') return PROVIDER_CHECK[value] ?? { label: humanize(value), tone: 'muted' };
  return null;
}

export const LISTING_STATUS: Record<string, StatusInfo> = {
  fixed_price: { label: 'Fixed price', tone: 'neutral' },
  auction: { label: 'Auction', tone: 'neutral' },
  make_offer: { label: 'Make offer', tone: 'neutral' },
  not_listed: { label: 'Not listed', tone: 'muted' },
  unknown: { label: 'Unknown', tone: 'caution', unresolved: true },
};

/** Link text for a purchase destination. A website link opens the provider's home page with no name prefilled. */
export const DESTINATION_LABEL: Record<string, string> = {
  search: 'Open',
  dashboard: 'Dashboard',
  website: 'Website',
  checkout: 'Checkout',
  listing: 'Listing',
};

/** Short qualifier shown beside destinations that do not lead straight to the name. */
export const DESTINATION_NOTE: Record<string, string> = {
  dashboard: 'Sign-in required',
  website: 'Name not prefilled',
};
