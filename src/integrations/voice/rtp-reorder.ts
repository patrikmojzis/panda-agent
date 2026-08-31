const RTP_SEQUENCE_MOD = 0x1_0000;
const RTP_SEQUENCE_HALF = 0x8000;

export type RtpReorderOutput<T> = {kind: "packet"; packet: T} | {kind: "loss"};

/** Bounded RTP sequence reorder buffer with explicit packet-loss markers. */
export class RtpReorderBuffer<T> {
  private expected?: number;
  private readonly pending = new Map<number, T>();
  private discardUntil = 0;

  constructor(private readonly depth = 4) {}

  get hasPending(): boolean { return this.pending.size > 0; }

  push(sequence: number, packet: T, now = Date.now()): RtpReorderOutput<T>[] {
    const normalized = sequence & 0xffff;
    if (now < this.discardUntil) { this.advancePast(normalized); return []; }
    this.expected ??= normalized;
    const distance = this.distance(normalized);
    if (distance >= RTP_SEQUENCE_HALF || this.pending.has(normalized)) return [];
    this.pending.set(normalized, packet);
    const ready = this.drainReady();
    if (this.pending.size >= this.depth) ready.push(...this.flush());
    return ready;
  }

  flush(): RtpReorderOutput<T>[] {
    if (this.expected === undefined || this.pending.size === 0) return [];
    const nearest = [...this.pending.keys()].reduce((best, sequence) => Math.min(best, this.distance(sequence)), RTP_SEQUENCE_MOD);
    const output: RtpReorderOutput<T>[] = [];
    for (let index = 0; index < Math.min(nearest, this.depth); index += 1) {
      output.push({kind: "loss"});
      this.expected = (this.expected + 1) & 0xffff;
    }
    if (nearest > this.depth) this.expected = [...this.pending.keys()].reduce((best, sequence) => this.distance(sequence) < this.distance(best) ? sequence : best);
    output.push(...this.drainReady());
    return output;
  }

  reset(): void { this.expected = undefined; this.pending.clear(); this.discardUntil = 0; }

  discardPending(now = Date.now(), quarantineMs = 0): void {
    if (this.expected !== undefined && this.pending.size > 0) {
      let furthest = this.expected;
      let furthestDistance = 0;
      for (const sequence of this.pending.keys()) {
        const distance = this.distance(sequence);
        if (distance < RTP_SEQUENCE_HALF && distance >= furthestDistance) { furthest = sequence; furthestDistance = distance; }
      }
      this.expected = (furthest + 1) & 0xffff;
    }
    this.pending.clear();
    this.discardUntil = Math.max(this.discardUntil, now + Math.max(0, quarantineMs));
  }

  private advancePast(sequence: number): void {
    if (this.expected === undefined) { this.expected = (sequence + 1) & 0xffff; return; }
    if (this.distance(sequence) < RTP_SEQUENCE_HALF) this.expected = (sequence + 1) & 0xffff;
  }

  private distance(sequence: number): number { return (sequence - (this.expected ?? sequence) + RTP_SEQUENCE_MOD) % RTP_SEQUENCE_MOD; }

  private drainReady(): RtpReorderOutput<T>[] {
    const output: RtpReorderOutput<T>[] = [];
    while (this.expected !== undefined && this.pending.has(this.expected)) {
      const packet = this.pending.get(this.expected)!;
      this.pending.delete(this.expected);
      output.push({kind: "packet", packet});
      this.expected = (this.expected + 1) & 0xffff;
    }
    return output;
  }
}
