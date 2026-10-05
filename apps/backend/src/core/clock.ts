/** Injectable time source so freshness, cooldowns and schedules are testable. */
export abstract class Clock {
  abstract now(): Date;
  iso(): string {
    return this.now().toISOString();
  }
  /** ISO timestamp `ms` milliseconds from now. */
  plus(ms: number): string {
    return new Date(this.now().getTime() + ms).toISOString();
  }
}

export class SystemClock extends Clock {
  now() {
    return new Date();
  }
}

/** Manually advanced clock for tests. */
export class FakeClock extends Clock {
  constructor(private current = new Date('2026-10-05T12:00:00.000Z')) {
    super();
  }
  now() {
    return new Date(this.current.getTime());
  }
  set(date: Date | string) {
    this.current = new Date(date);
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}
