import type { Eligibility, Reason, RegistrationDetails, RegistryOutcome } from '@domain-scout/contracts';


export interface Classification {
  outcome: RegistryOutcome;
  reason: Reason;
  httpStatus: number | null;

  matchedName: string | null;
  registration: RegistrationDetails | null;
  eligibility: Eligibility;

  retryable: boolean;

  cooldownUntil: string | null;
  retryAt: string | null;
}

export const UNKNOWN_ELIGIBILITY: Eligibility = { status: 'unknown', source: null, scope: null };


export function unresolved(
  outcome: Extract<RegistryOutcome, 'inconclusive' | 'rate_limited' | 'blocked'>,
  code: string,
  message: string,
  extra: Partial<Classification> = {},
): Classification {
  return {
    outcome,
    reason: { code, message },
    httpStatus: null,
    matchedName: null,
    registration: null,
    eligibility: UNKNOWN_ELIGIBILITY,
    retryable: false,
    cooldownUntil: null,
    retryAt: null,
    ...extra,
  };
}

export const NO_RECORD_NOTE = 'This does not establish that the name can be registered or at what price.';
