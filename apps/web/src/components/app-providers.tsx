'use client';

import { useState } from 'react';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, useTheme } from 'next-themes';
import { Toaster, toast } from 'sonner';
import { ApiRequestError, errorMessage, isUnauthorized } from '@/lib/api';
import { markSessionRequired } from '@/lib/session';
import { TooltipProvider } from './ui/tooltip';

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: { silent?: boolean };
  }
}

function makeClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (isUnauthorized(error)) markSessionRequired();
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (isUnauthorized(error)) {
          markSessionRequired();
          return;
        }
        if (!mutation.meta?.silent) toast.error(errorMessage(error));
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        // Client errors (4xx) are answers, not transient failures.
        retry: (count, error) => !(error instanceof ApiRequestError && error.status < 500) && count < 2,
      },
    },
  });
}

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      position="bottom-right"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--foreground)',
          '--normal-border': 'transparent',
          '--error-bg': 'var(--popover)',
          '--error-text': 'var(--foreground)',
          '--error-border': 'transparent',
          '--success-bg': 'var(--popover)',
          '--success-text': 'var(--foreground)',
          '--success-border': 'transparent',
        } as React.CSSProperties
      }
      toastOptions={{ classNames: { toast: 'font-sans shadow-xl', description: 'text-muted-foreground' } }}
    />
  );
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [client] = useState(makeClient);
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={client}>
        <TooltipProvider delayDuration={250}>
          {children}
          <ThemedToaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
