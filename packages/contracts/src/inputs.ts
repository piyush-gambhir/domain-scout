import { z } from 'zod';
import { AsciiDomain, Suffix, envelope } from './common.js';

export const NormalizedDomain = z
  .object({
    ascii: AsciiDomain,
    unicode: z.string(),
    label: z.string().meta({ description: 'Registrable label (A-label) without the suffix' }),
    suffix: Suffix,
    isIdn: z.boolean(),
  })
  .meta({ id: 'NormalizedDomain' });
export type NormalizedDomain = z.infer<typeof NormalizedDomain>;

export const InputRowStatus = z
  .enum(['valid', 'duplicate', 'invalid', 'ambiguous'])
  .meta({
    id: 'InputRowStatus',
    description:
      'valid rows are queued; duplicate rows repeat an earlier valid domain; invalid rows cannot be queried; ambiguous rows need a decision (see suggestion) and are not queued',
  });
export type InputRowStatus = z.infer<typeof InputRowStatus>;

export const InputReasonCode = z
  .enum([
    'empty',
    'invalid_characters',
    'label_too_long',
    'name_too_long',
    'hyphen_position',
    'unknown_suffix',
    'private_suffix',
    'hostname_not_registrable',
    'suffix_only',
    'idn_converted',
    'idn_invalid',
    'idn_support_unknown',
    'expanded_from_base',
    'duplicate',
    'normalized_case',
    'stripped_url',
    'trailing_dot_removed',
    'no_extensions_selected',
  ])
  .meta({ id: 'InputReasonCode' });
export type InputReasonCode = z.infer<typeof InputReasonCode>;

export const InputReason = z
  .object({ code: InputReasonCode, message: z.string() })
  .meta({ id: 'InputReason' });
export type InputReason = z.infer<typeof InputReason>;

export const InputPreviewRow = z
  .object({
    row: z.number().int().min(1).meta({ description: '1-based source row (line or CSV record)' }),
    original: z.string(),
    status: InputRowStatus,
    domain: NormalizedDomain.nullable(),
    reasons: z.array(InputReason),
    suggestion: z.string().nullable().meta({ description: 'Suggested registrable domain for ambiguous rows' }),
    duplicateOf: z.string().nullable(),
    expandedFrom: z.string().nullable().meta({ description: 'Base name this row was expanded from' }),
  })
  .meta({ id: 'InputPreviewRow' });
export type InputPreviewRow = z.infer<typeof InputPreviewRow>;

export const InputSource = z
  .object({
    text: z.string().max(5_000_000).optional().meta({ description: 'Pasted text, TXT or CSV content' }),
    format: z.enum(['auto', 'lines', 'csv']).default('auto'),
    csvColumn: z.string().optional().meta({ description: 'CSV header to read; defaults to the first column' }),
    domains: z.array(z.string()).max(100_000).optional(),
    extensions: z.array(Suffix).max(2000).default([]),
    presetId: z.string().optional().meta({ description: 'Extension preset whose suffixes are added to extensions' }),
  })
  .meta({ id: 'InputSource' });
export type InputSource = z.input<typeof InputSource>;
export type InputSourceParsed = z.output<typeof InputSource>;

export const InputPreview = z
  .object({
    rows: z.array(InputPreviewRow),
    domains: z.array(AsciiDomain).meta({ description: 'Unique valid domains in input order' }),
    extensions: z.array(Suffix),
    counts: z.object({
      inputRows: z.number().int(),
      valid: z.number().int(),
      duplicate: z.number().int(),
      invalid: z.number().int(),
      ambiguous: z.number().int(),
      uniqueDomains: z.number().int(),
      totalChecks: z.number().int(),
    }),
  })
  .meta({ id: 'InputPreview' });
export type InputPreview = z.infer<typeof InputPreview>;
export const InputPreviewResponse = envelope(InputPreview, 'InputPreviewResponse');
