/**
 * The last few lines the SDK subprocess said on stderr (spec 0219 E).
 *
 * Spec 0219 §5: three concurrent runs, one worked and two produced nothing and
 * were killed by the stall watchdog at exactly 300 000 ms. The cause is still
 * unknown, and it is unknown for a mechanical reason — the subprocess's own
 * stderr was discarded, so the only channel that could say "rate limited,
 * retrying" or say nothing at all was thrown away, and the sole surviving
 * evidence was OUR timeout, which reports our threshold and not its reason.
 *
 * Deliberately not a semaphore. Spec 0219 decision 3 and verification rule #5:
 * "two works, three stalled" is one observation, and a cap set to a number
 * nobody can explain is an exact constant treated as a habit. Instrument first.
 *
 * Bounded on purpose: a chatty subprocess must not grow this without limit, and
 * only the tail is diagnostic anyway.
 */
export interface StderrTail {
  /** Feed the SDK's `options.stderr` callback into this. */
  capture(chunk: string): void;
  /** The last `maxLines` non-empty lines, newest last. "" when it said nothing. */
  tail(): string;
}

export function createStderrTail(maxLines = 20): StderrTail {
  const lines: string[] = [];
  return {
    capture(chunk: string) {
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        lines.push(trimmed);
        if (lines.length > maxLines) lines.shift();
      }
    },
    tail() {
      return lines.join("\n");
    },
  };
}
