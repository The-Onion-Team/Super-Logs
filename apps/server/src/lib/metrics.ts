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
  alertsSent: 0,
  alertsFailed: 0,
  securitySignals: 0,
  securityFindingsOpened: 0,
};

/**
 * How client addresses have been arriving, for the security posture checks.
 * Kept apart from `metrics` because it holds an address (the proxy's) and
 * `metrics` is shown to every signed-in user.
 */
export const proxyObservation = {
  /** A forwarding header arrived while SUPER_LOGS_TRUST_PROXY is on, from a public socket address. */
  publicSourceAt: null as number | null,
  publicSource: null as string | null,
  /** A forwarding header arrived while SUPER_LOGS_TRUST_PROXY is off. */
  ignoredHeaderAt: null as number | null,
};
