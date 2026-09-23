/**
 * Notification channels configured from the dashboard, per project.
 *
 * These sit alongside the environment-configured channels rather than
 * replacing them: `SUPER_LOGS_TELEGRAM_*` still alerts for every project, and
 * a project can add its own chat on top. Storing them here is what lets a
 * bot token be entered in a form instead of a file and a restart.
 *
 * The bot token is stored as given, because Super-Logs has to present it to
 * Telegram on every send. It never leaves the server: the API returns only the
 * bot id (the digits before the colon, which are not secret) so the dashboard
 * can show *which* bot is configured without being able to use it.
 */
import type { Level } from "@super-logs/shared";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { newId } from "../lib/crypto.js";
import type { AlertChannel } from "./alerts.js";
import { telegramChannel } from "./telegram.js";

export type ChannelKind = "telegram";
export const CHANNEL_KINDS: readonly ChannelKind[] = ["telegram"];

export interface TelegramSettings {
  botToken: string;
  chatId: string;
  threadId?: number;
}

export interface StoredChannel {
  id: string;
  projectId: string;
  kind: ChannelKind;
  enabled: boolean;
  minLevel: Level;
  settings: TelegramSettings;
  createdAt: string;
  updatedAt: string;
  lastOkAt: string | null;
  lastError: string | null;
}

/** The shape the dashboard receives. Deliberately missing `botToken`. */
export interface ChannelSummary {
  id: string;
  kind: ChannelKind;
  enabled: boolean;
  minLevel: Level;
  /** The public half of the token, e.g. `8123456789`. Null if it looks malformed. */
  botId: string | null;
  chatId: string;
  threadId: number | null;
  createdAt: string;
  updatedAt: string;
  lastOkAt: string | null;
  lastError: string | null;
}

interface ChannelRow {
  id: string;
  project_id: string;
  kind: ChannelKind;
  enabled: number;
  min_level: Level;
  settings: string;
  created_at: number;
  updated_at: number;
  last_ok_at: number | null;
  last_error: string | null;
}

function toChannel(row: ChannelRow): StoredChannel {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    enabled: row.enabled === 1,
    minLevel: row.min_level,
    settings: JSON.parse(row.settings) as TelegramSettings,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastOkAt: row.last_ok_at === null ? null : new Date(row.last_ok_at).toISOString(),
    lastError: row.last_error,
  };
}

export function toSummary(channel: StoredChannel): ChannelSummary {
  const [botId] = channel.settings.botToken.split(":");
  return {
    id: channel.id,
    kind: channel.kind,
    enabled: channel.enabled,
    minLevel: channel.minLevel,
    botId: botId && /^\d+$/.test(botId) ? botId : null,
    chatId: channel.settings.chatId,
    threadId: channel.settings.threadId ?? null,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
    lastOkAt: channel.lastOkAt,
    lastError: channel.lastError,
  };
}

export function getChannel(db: Db, projectId: string, kind: ChannelKind): StoredChannel | null {
  const row = db
    .prepare("SELECT * FROM notification_channels WHERE project_id = ? AND kind = ?")
    .get(projectId, kind) as unknown as ChannelRow | undefined;
  return row ? toChannel(row) : null;
}

export function listChannels(db: Db, projectId: string): StoredChannel[] {
  const rows = db
    .prepare("SELECT * FROM notification_channels WHERE project_id = ? ORDER BY kind")
    .all(projectId) as unknown as ChannelRow[];
  return rows.map(toChannel);
}

export interface ChannelInput {
  enabled: boolean;
  minLevel: Level;
  /** Omitted when the operator is editing the chat without retyping the token. */
  botToken?: string;
  chatId: string;
  threadId?: number;
}

/**
 * Creates or replaces this project's channel of that kind. Leaving `botToken`
 * out keeps the stored one, so changing the chat id does not mean fetching the
 * token out of Telegram again. Returns null when there is nothing to keep.
 */
export function saveChannel(db: Db, projectId: string, kind: ChannelKind, input: ChannelInput, now = Date.now()): StoredChannel | null {
  const existing = getChannel(db, projectId, kind);
  const botToken = input.botToken ?? existing?.settings.botToken;
  if (!botToken) return null;

  const settings: TelegramSettings = { botToken, chatId: input.chatId };
  if (input.threadId !== undefined) settings.threadId = input.threadId;
  const json = JSON.stringify(settings);
  // A new token or chat is a new configuration: past failures no longer apply.
  const changed = !existing || existing.settings.botToken !== botToken || existing.settings.chatId !== input.chatId;

  if (existing) {
    db.prepare(
      `UPDATE notification_channels
       SET enabled = ?, min_level = ?, settings = ?, updated_at = ?,
           last_error = CASE WHEN ? THEN NULL ELSE last_error END
       WHERE id = ?`,
    ).run(input.enabled ? 1 : 0, input.minLevel, json, now, changed ? 1 : 0, existing.id);
    return getChannel(db, projectId, kind);
  }

  db.prepare(
    `INSERT INTO notification_channels (id, project_id, kind, enabled, min_level, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId("nch"), projectId, kind, input.enabled ? 1 : 0, input.minLevel, json, now, now);
  return getChannel(db, projectId, kind);
}

export function deleteChannel(db: Db, projectId: string, kind: ChannelKind): boolean {
  const result = db.prepare("DELETE FROM notification_channels WHERE project_id = ? AND kind = ?").run(projectId, kind);
  return Number(result.changes) > 0;
}

/** Remembers how the last delivery went, so the dashboard can show it. */
export function recordChannelResult(db: Db, channelId: string, error: string | null, now = Date.now()): void {
  if (error === null) {
    db.prepare("UPDATE notification_channels SET last_ok_at = ?, last_error = NULL WHERE id = ?").run(now, channelId);
  } else {
    db.prepare("UPDATE notification_channels SET last_error = ? WHERE id = ?").run(error.slice(0, 500), channelId);
  }
}

/** Turns a stored row into something `dispatchPendingAlerts` can send through. */
export function toAlertChannel(db: Db, channel: StoredChannel, config: Config): AlertChannel {
  const inner = telegramChannel({
    botToken: channel.settings.botToken,
    chatId: channel.settings.chatId,
    threadId: channel.settings.threadId,
    minLevel: channel.minLevel,
    publicOrigin: config.publicOrigin,
    apiBaseUrl: config.telegramApiBaseUrl,
  });
  return {
    // The id keeps this distinct from the environment-configured `telegram`,
    // so both can deliver the same alert without one masking the other.
    name: `${channel.kind}:${channel.id}`,
    accepts: inner.accepts,
    send: async (alert) => {
      try {
        await inner.send(alert);
        recordChannelResult(db, channel.id, null);
      } catch (error) {
        recordChannelResult(db, channel.id, error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  };
}

/** Every enabled channel this project has configured in the dashboard. */
export function projectChannels(db: Db, projectId: string, config: Config): AlertChannel[] {
  return listChannels(db, projectId)
    .filter((channel) => channel.enabled)
    .map((channel) => toAlertChannel(db, channel, config));
}
