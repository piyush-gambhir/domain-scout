/** Settings sections in order. Shared by the server route (validation, titles) and the client page. */
export const SETTINGS_SECTIONS = [
  { id: 'providers', label: 'Providers' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'checks', label: 'Checks' },
  { id: 'coverage', label: 'Coverage' },
  { id: 'prices', label: 'Price history' },
  { id: 'exports', label: 'Exports' },
  { id: 'data', label: 'Data' },
  { id: 'service', label: 'Service' },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id'];

export function isSettingsSection(value: string): value is SettingsSection {
  return SETTINGS_SECTIONS.some((s) => s.id === value);
}
