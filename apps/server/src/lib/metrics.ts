/** Super-Logs watching itself (IDEA §32): process-local counters, exposed on /api/system. */
export const metrics = {
  startedAt: Date.now(),
  ingestRequests: 0,
  ingestUnauthorized: 0,
  ingestRateLimited: 0,
  eventsAccepted: 0,
  eventsRejected: 0,
  ingestErrors: 0,
  lastIngestMs: 0,
  retentionDeleted: 0,
  retentionLastRun: null as string | null,
  retentionLastError: null as string | null,
  loginFailures: 0,
};
