/**
 * Alert delivery channels. An incident is queued once per cooldown window
 * (see `incidents.ts`); each configured channel then delivers that one alert
 * independently, so a failing webhook never resends a Telegram message that
 * already arrived.
 */
import type { Level } from "@super-logs/shared";
import type { Config } from "../config.js";
import { telegramChannel } from "./telegram.js";

/** What a channel is given. Flat on purpose: it is also the webhook's JSON. */
export interface IncidentAlert {
  alertId: number;
  id: string;
  projectId: string;
  projectName: string;
  fingerprint: string;
  status: "open" | "resolved";
  level: Level;
  eventCount: number;
  firstSeen: string;
  lastSeen: string;
  title: string;
  message: string;
  service: string | null;
  route: string | null;
}

export interface AlertChannel {
  /** Stored per delivery, so `name` must be stable across releases. */
  name: string;
  /** Alerts this channel does not accept settle without being sent. */
  accepts?: (alert: IncidentAlert) => boolean;
  /** Resolves when delivered; throws with a human-readable reason otherwise. */
  send: (alert: IncidentAlert) => Promise<void>;
}

/** The original generic JSON webhook, unchanged on the wire. */
export function webhookChannel(webhookUrl: string): AlertChannel {
  return {
    name: "webhook",
    async send(alert) {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "super_logs_incident", incident: alert }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`webhook responded ${response.status}`);
    },
  };
}

/** Every channel the environment turned on. Empty means alerts stay local. */
export function channelsFromConfig(config: Config): AlertChannel[] {
  const channels: AlertChannel[] = [];
  if (config.alertWebhookUrl) channels.push(webhookChannel(config.alertWebhookUrl));
  if (config.telegram) {
    channels.push(
      telegramChannel({
        ...config.telegram,
        publicOrigin: config.publicOrigin,
      }),
    );
  }
  return channels;
}
