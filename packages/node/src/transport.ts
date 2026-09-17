import { LIMITS, type IngestBatch, type SuperLogsEvent } from "@super-logs/shared";

export interface TransportOptions {
  /** Full ingest URL, e.g. `https://logs.example.com/api/ingest`. */
  endpoint: string;
  apiKey: string;
  batchSize: number;
  flushIntervalMs: number;
  maxQueueSize: number;
  timeoutMs: number;
  fetch: typeof fetch;
  /** Called for delivery problems. Must not log through the SDK itself. */
  onError: (error: Error) => void;
}

export interface TransportStats {
  queued: number;
  sent: number;
  dropped: number;
  failedBatches: number;
  lastError?: string;
  backoffUntil?: string;
}

const MAX_BACKOFF_MS = 60_000;

/**
 * A bounded in-memory queue drained in batches.
 *
 * Rules that keep an app safe when Super-Logs is slow or down:
 * - `push` is synchronous and O(1); it never awaits the network.
 * - The queue is bounded; when full, the OLDEST events are dropped.
 * - Only one request is in flight at a time, each with a hard timeout.
 * - Retryable failures back off exponentially up to a minute.
 * - Timers are unref'd so they never keep the process alive.
 */
export class Transport {
  private queue: SuperLogsEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private failures = 0;
  private backoffUntil = 0;
  private closed = false;
  private readonly counters = { sent: 0, dropped: 0, failedBatches: 0 };
  private lastError: string | undefined;

  constructor(private readonly options: TransportOptions) {
    this.timer = setInterval(() => void this.flush(), options.flushIntervalMs);
    this.timer.unref?.();
  }

  push(event: SuperLogsEvent): void {
    if (this.closed) return;
    if (this.queue.length >= this.options.maxQueueSize) {
      this.queue.shift();
      this.counters.dropped++;
    }
    this.queue.push(event);
    if (this.queue.length >= this.options.batchSize && !this.inFlight) {
      setImmediate(() => void this.flush()).unref?.();
    }
  }

  stats(): TransportStats {
    return {
      queued: this.queue.length,
      ...this.counters,
      lastError: this.lastError,
      backoffUntil: this.backoffUntil > Date.now() ? new Date(this.backoffUntil).toISOString() : undefined,
    };
  }

  /** Sends everything queued (subject to backoff). Never rejects. */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.drain().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Stops the timer and makes a last delivery attempt, bounded by `timeoutMs`. */
  async close(timeoutMs = this.options.timeoutMs): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.backoffUntil = 0;
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    this.closed = true;
  }

  private async drain(): Promise<void> {
    while (this.queue.length && Date.now() >= this.backoffUntil) {
      const batch = this.takeBatch();
      const outcome = await this.send(batch);
      if (outcome === "retry") {
        // Put the batch back at the front, within the queue bound.
        const room = this.options.maxQueueSize - this.queue.length;
        if (room < batch.length) this.counters.dropped += batch.length - Math.max(room, 0);
        this.queue.unshift(...batch.slice(0, Math.max(room, 0)));
        this.failures++;
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.failures - 1));
        this.backoffUntil = Date.now() + delay * (0.75 + Math.random() * 0.5);
        return;
      }
      if (outcome === "drop") {
        this.counters.dropped += batch.length;
        this.counters.failedBatches++;
      } else {
        this.counters.sent += batch.length;
        this.failures = 0;
      }
    }
  }

  /** Takes up to `batchSize` events whose JSON fits the server's byte limit. */
  private takeBatch(): SuperLogsEvent[] {
    const max = Math.min(this.options.batchSize, LIMITS.maxEventsPerBatch);
    const batch: SuperLogsEvent[] = [];
    let bytes = 16;
    while (batch.length < max && this.queue.length) {
      const next = this.queue[0]!;
      const size = Buffer.byteLength(JSON.stringify(next)) + 1;
      if (size > LIMITS.maxBatchBytes - 16) {
        // A single event too large to ever be accepted.
        this.queue.shift();
        this.counters.dropped++;
        continue;
      }
      if (bytes + size > LIMITS.maxBatchBytes) break;
      bytes += size;
      batch.push(this.queue.shift()!);
    }
    return batch;
  }

  private async send(events: SuperLogsEvent[]): Promise<"ok" | "retry" | "drop"> {
    if (!events.length) return "ok";
    const body: IngestBatch = { events };
    try {
      const response = await this.options.fetch(this.options.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
          "user-agent": "super-logs-node/0.1.0",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      // Always drain the body so the connection can be reused.
      await response.arrayBuffer().catch(() => undefined);
      if (response.ok) {
        this.lastError = undefined;
        return "ok";
      }
      const error = new Error(`Super-Logs ingest answered HTTP ${response.status}`);
      this.report(error);
      return response.status === 429 || response.status >= 500 ? "retry" : "drop";
    } catch (cause) {
      this.report(new Error(`Super-Logs ingest unreachable: ${cause instanceof Error ? cause.message : String(cause)}`));
      return "retry";
    }
  }

  private report(error: Error): void {
    // Report a given failure once, not once per batch, until it changes.
    if (this.lastError === error.message) return;
    this.lastError = error.message;
    try {
      this.options.onError(error);
    } catch {
      /* a failing error handler must not break delivery */
    }
  }
}
