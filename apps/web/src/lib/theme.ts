'use client';

import { useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import type { Settings } from '@domain-scout/contracts';
import { api } from './api';
import { qk, useSettings } from './queries';
import { readStorage } from './storage';

export type ThemeChoice = Settings['appearance']['theme'];

/** next-themes keeps the browser's choice under this localStorage key. */
const THEME_STORAGE_KEY = 'theme';

/** Theme switch that also saves settings.appearance.theme, so a new browser starts with the same theme. */
export function useThemePreference() {
  const { theme, setTheme } = useTheme();
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: async (value: ThemeChoice) => (await api.call('patchSettings', { body: { appearance: { theme: value } } })).data,
    onSuccess: (settings) => client.setQueryData(qk.settings, settings),
    meta: { silent: true },
  });
  return {
    theme: (theme ?? 'system') as ThemeChoice,
    setTheme: (value: ThemeChoice) => {
      setTheme(value);
      save.mutate(value);
    },
  };
}

/**
 * Applies the saved theme once per page load when this browser has no choice of its own yet.
 * A choice made in this browser wins locally; every change through useThemePreference saves both.
 */
export function ThemeSync() {
  const settings = useSettings();
  const { setTheme } = useTheme();
  const applied = useRef(false);
  const saved = settings.data?.appearance.theme;
  useEffect(() => {
    if (applied.current || !saved) return;
    applied.current = true;
    if (readStorage('local', THEME_STORAGE_KEY) === null) setTheme(saved);
  }, [saved, setTheme]);
  return null;
}
