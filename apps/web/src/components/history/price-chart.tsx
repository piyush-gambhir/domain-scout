'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import type { PriceSeries } from '@domain-scout/contracts';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';

const HEIGHT = 168;
const PAD = { top: 12, right: 16, bottom: 24, left: 64 };

export type PriceField = 'registration' | 'renewal' | 'transfer';

/** The amount a series is about: transfer series chart the transfer price, renewal series the renewal. */
export function primaryField(series: Pick<PriceSeries, 'purchasePath'>): PriceField {
  if (series.purchasePath === 'transfer') return 'transfer';
  if (series.purchasePath === 'renewal') return 'renewal';
  return 'registration';
}

interface Plotted {
  time: number;
  /** Plot position only. Displayed amounts always use the original decimal string. */
  value: number;
  amount: string;
  observedAt: string;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function niceTicks(min: number, max: number, count = 3): number[] {
  if (min === max) return [min];
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step / 1e6; t += step) ticks.push(Number(t.toFixed(10)));
  return ticks;
}

/**
 * Observed prices over time for one comparable series. Unknown amounts are not plotted, and the line
 * breaks at unknown amounts and at reported gaps: missing periods stay visibly missing.
 */
export function PriceChart({ series, field }: { series: PriceSeries; field: PriceField }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const sorted = [...series.points].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const gaps = series.gaps.map((g) => ({ from: new Date(g.from).getTime(), to: new Date(g.to).getTime() }));
  const times = [...sorted.map((p) => new Date(p.observedAt).getTime()), ...gaps.flatMap((g) => [g.from, g.to])];

  // Segments break on an unknown amount or a reported gap between neighbours.
  const segments: Plotted[][] = [];
  const plotted: Plotted[] = [];
  let current: Plotted[] = [];
  let previousTime: number | null = null;
  for (const point of sorted) {
    const time = new Date(point.observedAt).getTime();
    const amount = point[field];
    const gapBetween = previousTime !== null && gaps.some((g) => g.to > previousTime! && g.from < time);
    if (amount === null || gapBetween) {
      if (current.length) segments.push(current);
      current = [];
    }
    if (amount !== null) {
      const entry = { time, value: Number(amount), amount, observedAt: point.observedAt };
      current.push(entry);
      plotted.push(entry);
    }
    previousTime = time;
  }
  if (current.length) segments.push(current);

  const summary = `${plotted.length} observed ${field} prices${gaps.length ? ` with ${gaps.length} period${gaps.length === 1 ? '' : 's'} without observations` : ''}`;
  // The measured wrapper stays mounted so a later refetch with known amounts can draw.
  if (plotted.length === 0) {
    return (
      <div ref={ref} className="w-full">
        <p className="text-sm text-muted-foreground">No known {field} amounts to chart.</p>
      </div>
    );
  }

  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const values = plotted.map((p) => p.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  // Pad the observed range so points never sit on the plot edge; ticks fall inside it.
  const spread = high - low || Math.max(high * 0.1, 1);
  const yMin = Math.max(0, low - spread * 0.25);
  const yMax = high + spread * 0.25;
  const ticks = niceTicks(yMin, yMax);

  const innerWidth = Math.max(0, width - PAD.left - PAD.right);
  const innerHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (time: number) => PAD.left + (maxTime === minTime ? innerWidth / 2 : ((time - minTime) / (maxTime - minTime)) * innerWidth);
  const y = (value: number) => PAD.top + (yMax === yMin ? innerHeight / 2 : (1 - (value - yMin) / (yMax - yMin)) * innerHeight);

  const activePoint = active !== null ? plotted[active] : undefined;
  const nearest = (clientX: number, rect: DOMRect) => {
    const px = clientX - rect.left;
    let best = 0;
    plotted.forEach((p, i) => {
      if (Math.abs(x(p.time) - px) < Math.abs(x(plotted[best]!.time) - px)) best = i;
    });
    return best;
  };

  return (
    <div ref={ref} className="relative w-full">
      {width > 0 ? (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={summary}
          tabIndex={0}
          className="block overflow-visible rounded-sm"
          onPointerMove={(event) => setActive(nearest(event.clientX, event.currentTarget.getBoundingClientRect()))}
          onPointerLeave={() => setActive(null)}
          onBlur={() => setActive(null)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
              event.preventDefault();
              const step = event.key === 'ArrowRight' ? 1 : -1;
              setActive((i) => Math.min(plotted.length - 1, Math.max(0, i === null ? (step > 0 ? 0 : plotted.length - 1) : i + step)));
            } else if (event.key === 'Escape') setActive(null);
          }}
        >
          {gaps.map((gap, i) => (
            <rect
              key={i}
              x={x(gap.from)}
              y={PAD.top}
              width={Math.max(2, x(gap.to) - x(gap.from))}
              height={innerHeight}
              fill="var(--input)"
              data-testid="price-gap"
            />
          ))}
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} stroke="var(--input)" strokeWidth={1} />
              <text x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-muted-foreground font-mono text-[11px] tabular">
                {formatMoney(String(tick), series.currency)}
              </text>
            </g>
          ))}
          <text x={PAD.left} y={HEIGHT - 4} className="fill-muted-foreground text-[11px]">
            {formatDate(new Date(minTime).toISOString())}
          </text>
          {maxTime !== minTime ? (
            <text x={width - PAD.right} y={HEIGHT - 4} textAnchor="end" className="fill-muted-foreground text-[11px]">
              {formatDate(new Date(maxTime).toISOString())}
            </text>
          ) : null}
          {segments.map((segment, i) =>
            segment.length > 1 ? (
              <path
                key={i}
                d={segment.map((p, j) => `${j === 0 ? 'M' : 'L'}${x(p.time)},${y(p.value)}`).join(' ')}
                fill="none"
                stroke="var(--foreground)"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                data-testid="price-segment"
              />
            ) : null,
          )}
          {activePoint ? (
            <line x1={x(activePoint.time)} x2={x(activePoint.time)} y1={PAD.top} y2={PAD.top + innerHeight} stroke="var(--control)" strokeWidth={1} />
          ) : null}
          {plotted.map((p, i) => (
            <circle
              key={`${p.observedAt}-${i}`}
              cx={x(p.time)}
              cy={y(p.value)}
              r={i === active ? 5 : 4}
              fill="var(--foreground)"
              stroke="var(--background)"
              strokeWidth={2}
            />
          ))}
        </svg>
      ) : (
        <div style={{ height: HEIGHT }} />
      )}
      {activePoint ? (
        <div
          role="status"
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md bg-popover px-2.5 py-1.5 text-xs shadow-lg"
          style={{ left: Math.min(Math.max(x(activePoint.time), 80), width - 80) }}
        >
          <span className="block font-mono text-sm font-semibold tabular">{formatMoney(activePoint.amount, series.currency)}</span>
          <span className="text-muted-foreground">{formatDateTime(activePoint.observedAt)}</span>
        </div>
      ) : null}
    </div>
  );
}
