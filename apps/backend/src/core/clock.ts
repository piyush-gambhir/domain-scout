
export abstract class Clock {
  abstract now(): Date;
  iso(): string {
    return this.now().toISOString();
  }

  plus(ms: number): string {
    return new Date(this.now().getTime() + ms).toISOString();
  }
}

export class SystemClock extends Clock {
  now() {
    return new Date();
  }
}


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
