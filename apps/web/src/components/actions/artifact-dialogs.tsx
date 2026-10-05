'use client';

import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { RadioGroup } from 'radix-ui';
import { Download } from 'lucide-react';
import type { ExportArtifact, SnapshotArtifact } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { formatCount, plural } from '@/lib/format';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter } from '../ui/dialog';
import { Input } from '../ui/input';
import { Field } from '../ui/label';
import { Segmented } from '../ui/segmented';
import { SwitchField } from '../ui/switch';
import type { ScopeInput, ScopeOption } from './types';

type Format = 'txt' | 'csv' | 'json';

const FORMATS: { value: Format; label: string }[] = [
  { value: 'csv', label: 'CSV' },
  { value: 'json', label: 'JSON' },
  { value: 'txt', label: 'TXT' },
];

const scopeItemClass =
  'flex min-h-9 w-full items-center gap-3 rounded-md px-3 text-left text-sm transition-colors hover:bg-hover disabled:opacity-45 data-[state=checked]:bg-selected data-[state=checked]:font-medium';

function ScopePicker({ options, value, onChange }: { options: ScopeOption[]; value: string; onChange: (value: string) => void }) {
  const labelId = useId();
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground" id={labelId}>
        Scope
      </p>
      <RadioGroup.Root value={value} onValueChange={onChange} aria-labelledby={labelId} className="flex flex-col gap-0.5">
        {options.map((option) => (
          <RadioGroup.Item key={option.value} value={option.value} disabled={option.disabled} className={scopeItemClass}>
            {option.label}
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
    </div>
  );
}

/** Files are served by the backend through the /api/v1 forwarder; the session cookie authorizes the download. */
export function apiDownloadUrl(path: string): string {
  if (path.startsWith('/api/v1/')) return path;
  return `/api/v1${path.startsWith('/') ? '' : '/'}${path}`;
}

function triggerDownload(url: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function firstEnabled(options: ScopeOption[], preferred?: string) {
  const usable = options.filter((o) => !o.disabled);
  return usable.find((o) => o.value === preferred)?.value ?? usable[0]?.value ?? '';
}

export function ExportDialog({
  open,
  onOpenChange,
  scopes,
  defaultScope,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scopes: ScopeOption[];
  defaultScope?: string;
}) {
  const [format, setFormat] = useState<Format>('csv');
  const [scope, setScope] = useState<string | null>(null);
  // TXT keeps only names with no registry record or a positive confirmation unless every name is asked for.
  const [everyName, setEveryName] = useState(false);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [artifact, setArtifact] = useState<ExportArtifact | null>(null);
  const activeScope = scope ?? firstEnabled(scopes, defaultScope);

  const mutation = useMutation({
    mutationFn: async () => {
      const option = scopes.find((s) => s.value === activeScope);
      if (!option) throw new Error('Choose a scope.');
      const built: ScopeInput = await option.build();
      const response = await api.call('createExport', {
        body: { format, scope: built, includeNotes, ...(format === 'txt' && everyName ? { candidatesOnly: false } : {}) },
      });
      return response.data;
    },
    onSuccess: (data) => {
      setArtifact(data);
      triggerDownload(apiDownloadUrl(data.downloadPath));
    },
  });

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setArtifact(null);
      setScope(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title="Export">
        {artifact ? (
          <div className="flex flex-col gap-3 text-sm">
            <p>
              <span className="font-mono">{artifact.fileName}</span>
              <span className="text-muted-foreground"> · {plural(artifact.itemCount, 'row')}</span>
            </p>
            {artifact.warnings.length > 0 ? (
              <ul className="flex flex-col gap-1 rounded-md bg-caution/10 px-3 py-2">
                {artifact.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            <DialogFooter>
              <Button variant="ghost" onClick={() => close(false)}>
                Done
              </Button>
              <Button variant="primary" onClick={() => triggerDownload(apiDownloadUrl(artifact.downloadPath))}>
                <Download />
                Download again
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <Segmented aria-label="Format" value={format} onValueChange={setFormat} options={FORMATS} />
            <ScopePicker options={scopes} value={activeScope} onChange={setScope} />
            <div className="flex flex-col gap-3">
              {format === 'txt' ? (
                <SwitchField id="export-every-name" label="Also include registered and unresolved names" checked={everyName} onCheckedChange={setEveryName} />
              ) : null}
              <SwitchField id="export-notes" label="Include notes" checked={includeNotes} onCheckedChange={setIncludeNotes} />
            </div>
            <DialogFooter className="mt-1">
              <Button variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!activeScope || mutation.isPending} onClick={() => mutation.mutate()}>
                Export
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function SnapshotDialog({
  open,
  onOpenChange,
  scopes,
  defaultScope,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scopes: ScopeOption[];
  defaultScope?: string;
}) {
  const [title, setTitle] = useState('');
  const [scope, setScope] = useState<string | null>(null);
  const [include, setInclude] = useState({ evidence: true, prices: true, registration: true, notes: false });
  const [created, setCreated] = useState<SnapshotArtifact | null>(null);
  const activeScope = scope ?? firstEnabled(scopes, defaultScope);
  const effectiveTitle = title.trim() || `Snapshot ${new Date().toISOString().slice(0, 10)}`;

  const buildBody = async () => {
    const option = scopes.find((s) => s.value === activeScope);
    if (!option) throw new Error('Choose a scope.');
    return { title: effectiveTitle, scope: await option.build(), include };
  };

  const preview = useMutation({
    mutationFn: async () => (await api.call('previewSnapshot', { body: await buildBody() })).data,
  });
  const create = useMutation({
    mutationFn: async () => (await api.call('createSnapshot', { body: await buildBody() })).data,
    onSuccess: setCreated,
  });

  const resetPreview = () => preview.reset();
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setCreated(null);
      setScope(null);
      preview.reset();
    }
  };

  const sample = preview.data?.sample ?? [];
  const columns = preview.data?.fields.length ? preview.data.fields : Object.keys(sample[0] ?? {});

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title="Snapshot" wide>
        {created ? (
          <div className="flex flex-col gap-3 text-sm">
            <p>
              {created.title}
              <span className="text-muted-foreground"> · {plural(created.itemCount, 'item')}</span>
            </p>
            <p className="break-all font-mono text-xs text-muted-foreground">{created.htmlPath}</p>
            <DialogFooter>
              <Button variant="ghost" onClick={() => triggerDownload(apiDownloadUrl(`/snapshots/${created.id}/download?format=json`))}>
                <Download />
                JSON
              </Button>
              <Button variant="primary" onClick={() => triggerDownload(apiDownloadUrl(`/snapshots/${created.id}/download?format=html`))}>
                <Download />
                HTML
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <Field label="Title" htmlFor="snapshot-title">
              <Input
                id="snapshot-title"
                value={title}
                placeholder={effectiveTitle}
                maxLength={200}
                onChange={(e) => {
                  setTitle(e.target.value);
                  resetPreview();
                }}
              />
            </Field>
            <ScopePicker
              options={scopes}
              value={activeScope}
              onChange={(value) => {
                setScope(value);
                resetPreview();
              }}
            />
            <div className="grid gap-3 sm:grid-cols-2 sm:gap-x-8">
              {(
                [
                  ['evidence', 'Registry evidence'],
                  ['registration', 'Registration details'],
                  ['prices', 'Prices'],
                  ['notes', 'Private notes'],
                ] as const
              ).map(([key, label]) => (
                <SwitchField
                  key={key}
                  id={`snapshot-${key}`}
                  label={label}
                  checked={include[key]}
                  onCheckedChange={(value) => {
                    setInclude((current) => ({ ...current, [key]: value }));
                    resetPreview();
                  }}
                />
              ))}
            </div>

            {preview.data ? (
              <div className="flex flex-col gap-2" data-testid="snapshot-preview">
                <p className="text-sm">
                  {plural(preview.data.itemCount, 'item')}
                  <span className="text-muted-foreground">
                    {' '}
                    · {formatCount(preview.data.fields.length)} fields · {preview.data.includesNotes ? 'includes notes' : 'no notes'}
                  </span>
                </p>
                {sample.length > 0 ? (
                  <div className="max-h-56 overflow-auto rounded-md bg-input">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr>
                          {columns.map((column) => (
                            <th key={column} scope="col" className="sticky top-0 bg-input px-3 py-2 font-medium text-muted-foreground">
                              {column}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="font-mono">
                        {sample.slice(0, 8).map((row, index) => (
                          <tr key={index}>
                            {columns.map((column) => (
                              <td key={column} className="max-w-48 truncate px-3 py-1.5">
                                {row[column] === null || row[column] === undefined ? 'Unknown' : String(row[column])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            ) : null}

            <DialogFooter className="mt-1">
              <Button variant="ghost" disabled={preview.isPending} onClick={() => preview.mutate()}>
                Preview
              </Button>
              <Button variant="primary" disabled={!preview.data || create.isPending} onClick={() => create.mutate()}>
                Create snapshot
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
