import { z } from 'zod';
import { AsciiDomain, CurrencyCode, DecimalString, Suffix, Timestamp, Uuid, envelope, page } from './common.js';
import { ResultFilter } from './jobs.js';
import { ProviderId, ProviderConfirmation } from './providers.js';
import { RegistryObservation } from './registry.js';
import { Offer } from './pricing.js';

/* Collections (shortlists), saved criteria, extension presets and candidate generation. */

export const Collection = z
  .object({
    id: Uuid,
    name: z.string(),
    notes: z.string().nullable(),
    entryCount: z.number().int(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: 'Collection' });
export type Collection = z.infer<typeof Collection>;
export const CollectionResponse = envelope(Collection, 'CollectionResponse');
export const CollectionListResponse = page(Collection, 'CollectionListResponse');

export const CollectionCreate = z
  .object({ name: z.string().min(1).max(200), notes: z.string().max(20_000).optional() })
  .meta({ id: 'CollectionCreate' });
export const CollectionPatch = z
  .object({ name: z.string().min(1).max(200).optional(), notes: z.string().max(20_000).nullable().optional() })
  .meta({ id: 'CollectionPatch' });

export const CollectionEntry = z
  .object({
    id: Uuid,
    collectionId: Uuid,
    domain: AsciiDomain,
    unicode: z.string(),
    notes: z.string().nullable(),
    addedAt: Timestamp,
    registry: RegistryObservation.nullable().meta({ description: 'Latest registry evidence for the domain' }),
    confirmations: z.array(ProviderConfirmation),
    offers: z.array(Offer).meta({ description: 'Latest offers per provider and purchase path' }),
  })
  .meta({ id: 'CollectionEntry' });
export type CollectionEntry = z.infer<typeof CollectionEntry>;
export const CollectionEntryListResponse = page(CollectionEntry, 'CollectionEntryListResponse');

export const CollectionEntriesAdd = z
  .object({
    domains: z.array(z.string()).min(1).max(10_000),
    notes: z.string().max(20_000).optional(),
  })
  .meta({ id: 'CollectionEntriesAdd' });
export const CollectionEntriesAddResult = z
  .object({
    added: z.number().int(),
    existing: z.number().int(),
    rejected: z.array(z.object({ input: z.string(), reason: z.string() })),
  })
  .meta({ id: 'CollectionEntriesAddResult' });
export const CollectionEntriesAddResponse = envelope(CollectionEntriesAddResult, 'CollectionEntriesAddResponse');

export const CollectionEntryPatch = z
  .object({ notes: z.string().max(20_000).nullable() })
  .meta({ id: 'CollectionEntryPatch' });

export const CollectionEntriesRemove = z
  .object({ domains: z.array(AsciiDomain).min(1) })
  .meta({ id: 'CollectionEntriesRemove' });

export const GenerationStrategy = z
  .enum(['roots', 'affixes', 'compounds', 'syllables', 'mutations', 'hacks'])
  .meta({ id: 'GenerationStrategy' });
export type GenerationStrategy = z.infer<typeof GenerationStrategy>;

export const GenerationRequest = z
  .object({
    roots: z.array(z.string().max(63)).max(200).default([]),
    themes: z.array(z.string()).max(20).default([]).meta({ description: 'Bundled local word lists, see GET /generation/themes' }),
    prefixes: z.array(z.string().max(30)).max(200).default([]),
    suffixes: z.array(z.string().max(30)).max(200).default([]),
    strategies: z.array(GenerationStrategy).default(['roots', 'affixes', 'compounds']),
    rules: z
      .object({
        minLength: z.number().int().min(1).max(63).default(3),
        maxLength: z.number().int().min(1).max(63).default(15),
        allowDigits: z.boolean().default(false),
        allowHyphens: z.boolean().default(false),
        exclude: z.array(z.string().max(63)).max(500).default([]),
      })
      .default({ minLength: 3, maxLength: 15, allowDigits: false, allowHyphens: false, exclude: [] }),
    extensions: z.array(Suffix).max(500).default([]),
    limit: z.number().int().min(1).max(5000).default(300),
    seed: z.number().int().optional().meta({ description: 'Deterministic seed for syllable generation' }),
  })
  .meta({ id: 'GenerationRequest' });
export type GenerationRequest = z.input<typeof GenerationRequest>;
export type GenerationRequestParsed = z.output<typeof GenerationRequest>;

export const GeneratedCandidate = z
  .object({
    name: z.string().meta({ description: 'Label to expand across extensions, or a complete domain for hacks' }),
    domain: z.string().nullable().meta({ description: 'Complete domain for domain hacks' }),
    strategy: GenerationStrategy,
    rule: z.string().meta({ description: 'Human-readable generation rule' }),
    valid: z.boolean(),
    issues: z.array(z.string()),
  })
  .meta({ id: 'GeneratedCandidate' });
export type GeneratedCandidate = z.infer<typeof GeneratedCandidate>;

export const GenerationPreview = z
  .object({
    candidates: z.array(GeneratedCandidate),
    counts: z.object({
      generated: z.number().int(),
      unique: z.number().int(),
      duplicates: z.number().int(),
      invalid: z.number().int(),
      filtered: z.number().int(),
    }),
    extensions: z.array(Suffix),
    expandedChecks: z.number().int().meta({ description: 'Registry checks a scan of all valid candidates would run' }),
  })
  .meta({ id: 'GenerationPreview', description: 'Generated locally; nothing is sent to any registry or provider' });
export type GenerationPreview = z.infer<typeof GenerationPreview>;
export const GenerationPreviewResponse = envelope(GenerationPreview, 'GenerationPreviewResponse');

export const GenerationTheme = z
  .object({ id: z.string(), name: z.string(), size: z.number().int(), sample: z.array(z.string()) })
  .meta({ id: 'GenerationTheme' });
export const GenerationThemeListResponse = page(GenerationTheme, 'GenerationThemeListResponse');

export const SavedCriteria = z
  .object({
    id: Uuid,
    name: z.string(),
    filter: ResultFilter.nullable(),
    extensions: z.array(Suffix),
    providerIds: z.array(ProviderId),
    budget: z.object({ amount: DecimalString, currency: CurrencyCode }).nullable(),
    generation: GenerationRequest.nullable(),
    input: z.string().nullable().meta({ description: 'Saved candidate input text' }),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: 'SavedCriteria', description: 'Restoring criteria never runs queries' });
export type SavedCriteria = z.infer<typeof SavedCriteria>;
export const SavedCriteriaResponse = envelope(SavedCriteria, 'SavedCriteriaResponse');
export const SavedCriteriaListResponse = page(SavedCriteria, 'SavedCriteriaListResponse');

export const SavedCriteriaCreate = SavedCriteria.omit({ id: true, createdAt: true, updatedAt: true })
  .partial({ filter: true, extensions: true, providerIds: true, budget: true, generation: true, input: true })
  .meta({ id: 'SavedCriteriaCreate' });

export const ExtensionPreset = z
  .object({
    id: z.string(),
    name: z.string(),
    extensions: z.array(Suffix),
    builtIn: z.boolean(),
    createdAt: Timestamp.nullable(),
  })
  .meta({ id: 'ExtensionPreset' });
export type ExtensionPreset = z.infer<typeof ExtensionPreset>;
export const ExtensionPresetResponse = envelope(ExtensionPreset, 'ExtensionPresetResponse');
export const ExtensionPresetListResponse = page(ExtensionPreset, 'ExtensionPresetListResponse');

export const ExtensionPresetCreate = z
  .object({ name: z.string().min(1).max(100), extensions: z.array(Suffix).min(1).max(2000) })
  .meta({ id: 'ExtensionPresetCreate' });
