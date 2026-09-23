/**
 * Telegram delivery for incident alerts. One HTTPS POST to the Bot API, no
 * dependency and no bot library: `sendMessage` is a single JSON POST.
 *
 * Messages use `parse_mode: HTML` rather than MarkdownV2 on purpose. MarkdownV2
 * requires escaping eighteen characters, several of which (`.`, `-`, `(`, `_`)
 * are everywhere in stack traces and error text, and one missed escape makes
 * Telegram reject the whole message. HTML needs only `&`, `<` and `>`.
 */
import { LEVEL_RANK, type Level } from "@super-logs/shared";
import type { AlertChannel, IncidentAlert } from "./alerts.js";

/** The real Bot API. Anything else is a mirror or a test double. */
export const TELEGRAM_API = "https://api.telegram.org";

/** Telegram rejects anything longer. The error body absorbs the difference. */
const MAX_MESSAGE_CHARS = 4096;
const MAX_BODY_CHARS = 1500;

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  /** Alerts below this level are dropped instead of sent. */
  minLevel: Level;
  /** Optional topic id, for forum-style supergroups. */
  threadId?: number;
  /** Where the dashboard is reachable, for the "open incident" link. */
  publicOrigin: string;
  apiBaseUrl?: string;
}

const LEVEL_EMOJI: Record<Level, string> = {
  debug: "⚪",
  info: "🔵",
  warning: "🟠",
  error: "🔴",
  critical: "🚨",
};

/** Only `&`, `<` and `>` are special in Telegram's HTML mode. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escapes first and trims afterwards. Trimming first would be wrong: escaping
 * grows the text (`&` becomes `&amp;`), so a body of ampersands would blow
 * through the budget. Cutting escaped text risks splitting an entity, so any
 * half-written one is dropped from the tail.
 */
function clipHtml(value: string, max: number): string {
  const escaped = escapeHtml(value);
  if (escaped.length <= max) return escaped;
  return `${escaped.slice(0, max - 1).replace(/&[a-z]*$/i, "")}…`;
}

/** `2026-09-23T07:00:44.907Z` → `07:00:44 UTC`, which is what you want at 3am. */
function clock(iso: string): string {
  return `${iso.slice(11, 19)} UTC`;
}

function duration(fromIso: string, toIso: string): string {
  const ms = Math.max(0, Date.parse(toIso) - Date.parse(fromIso));
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function incidentUrl(alert: IncidentAlert, publicOrigin: string): string {
  const query = new URLSearchParams({ fingerprint: alert.fingerprint });
  return `${publicOrigin}/projects/${encodeURIComponent(alert.projectId)}/logs?${query}`;
}

/**
 * The alert as it appears in the chat: what broke, where, how bad, and a link
 * to the events behind it. The heading, the facts and the link are built
 * first; the error body then gets whatever of the 4096 characters is left, so
 * a huge stack trace can never push the link out of the message.
 */
export function formatTelegramMessage(alert: IncidentAlert, publicOrigin: string): string {
  const emoji = LEVEL_EMOJI[alert.level] ?? "🔴";
  const head = `${emoji} <b>${clipHtml(alert.title, 200)}</b>`;

  const facts: [string, string][] = [["Project", alert.projectName]];
  if (alert.service) facts.push(["Service", alert.service]);
  if (alert.route) facts.push(["Route", alert.route]);
  facts.push([
    "Events",
    alert.eventCount === 1
      ? `1 · ${clock(alert.lastSeen)}`
      : `${alert.eventCount.toLocaleString("en-US")} over ${duration(alert.firstSeen, alert.lastSeen)} · last ${clock(alert.lastSeen)}`,
  ]);
  facts.push(["Fingerprint", alert.fingerprint.slice(0, 12)]);

  const factLines = facts.map(([label, value]) => `<b>${label}:</b> ${clipHtml(value, 200)}`);
  const link = `<a href="${escapeHtml(incidentUrl(alert, publicOrigin))}">Open in Super-Logs →</a>`;
  const frame = [head, "", ...factLines, "", link];

  const body = alert.message.trim();
  if (!body || body === alert.title) return frame.join("\n");

  // The two extra newlines and the <pre> wrapper come out of the budget too.
  const budget = Math.min(MAX_BODY_CHARS, MAX_MESSAGE_CHARS - frame.join("\n").length - "\n\n<pre></pre>".length);
  if (budget < 80) return frame.join("\n");
  return [head, "", `<pre>${clipHtml(body, budget)}</pre>`, "", ...factLines, "", link].join("\n");
}

/**
 * Turns a Bot API failure into a message worth storing. Telegram answers 200
 * with `{ok: false}` as readily as it answers 4xx, so the body decides.
 */
function describeFailure(status: number, payload: unknown): string {
  const description =
    payload && typeof payload === "object" && typeof (payload as { description?: unknown }).description === "string"
      ? (payload as { description: string }).description
      : undefined;
  if (status === 401 || status === 404) return `telegram rejected the bot token (${status}${description ? `: ${description}` : ""})`;
  if (status === 400 && description?.includes("chat not found")) {
    // Deliberately says nothing about where the chat id came from: this same
    // message is shown for a dashboard-configured channel, where naming an
    // environment variable would send the reader to the wrong place.
    return "telegram chat not found: the bot cannot see that chat. Check the chat id, and make sure the bot has been started or added there.";
  }
  return `telegram responded ${status}${description ? `: ${description}` : ""}`;
}

export function telegramChannel(config: TelegramConfig): AlertChannel {
  const base = config.apiBaseUrl ?? TELEGRAM_API;
  const url = `${base}/bot${config.botToken}/sendMessage`;
  const threshold = LEVEL_RANK[config.minLevel];

  return {
    name: "telegram",
    accepts: (alert) => LEVEL_RANK[alert.level] >= threshold,
    async send(alert) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: config.chatId,
          text: formatTelegramMessage(alert, config.publicOrigin),
          parse_mode: "HTML",
          disable_web_page_preview: true,
          ...(config.threadId === undefined ? {} : { message_thread_id: config.threadId }),
        }),
        signal: AbortSignal.timeout(10_000),
      });

      const payload = await response.json().catch(() => undefined);
      const ok = response.ok && (payload as { ok?: boolean } | undefined)?.ok !== false;
      if (!ok) throw new Error(describeFailure(response.status, payload));
    },
  };
}

export interface DiscoveredChat {
  id: string;
  type: string;
  name: string;
}

interface TelegramChat {
  id: number | string;
  type: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

/**
 * Asks Telegram which bot a token belongs to and which chats it can post to.
 *
 * This is the step people get stuck on: Telegram will not reveal a chat id
 * until the bot has seen a message in that chat, and the usual advice is to
 * open a `getUpdates` URL by hand and read raw JSON. Doing it here means the
 * dashboard can offer the chats as buttons, and it goes through the configured
 * API base, so a mirror or proxy keeps working.
 */
export async function discoverChats(
  botToken: string,
  apiBaseUrl = TELEGRAM_API,
): Promise<{ ok: true; botUsername: string; chats: DiscoveredChat[] } | { ok: false; message: string }> {
  const call = async (method: string): Promise<{ ok: boolean; description?: string; result?: unknown }> => {
    const response = await fetch(`${apiBaseUrl}/bot${botToken}/${method}`, { signal: AbortSignal.timeout(10_000) });
    const payload = (await response.json().catch(() => undefined)) as { ok?: boolean; description?: string; result?: unknown } | undefined;
    if (!payload) return { ok: false, description: `Telegram responded ${response.status}` };
    return { ok: payload.ok === true, description: payload.description, result: payload.result };
  };

  let me: Awaited<ReturnType<typeof call>>;
  try {
    me = await call("getMe");
  } catch (error) {
    return { ok: false, message: error instanceof Error ? `Could not reach Telegram: ${error.message}` : "Could not reach Telegram." };
  }
  if (!me.ok) return { ok: false, message: me.description ?? "Telegram did not accept that token." };
  const botUsername = (me.result as { username?: string } | undefined)?.username ?? "bot";

  const updates = await call("getUpdates").catch(() => ({ ok: false, description: undefined, result: undefined }));
  const chats = new Map<string, DiscoveredChat>();
  for (const update of (updates.result as Record<string, { chat?: TelegramChat }>[] | undefined) ?? []) {
    const chat = (update.message ?? update.channel_post ?? update.my_chat_member)?.chat;
    if (!chat) continue;
    const name = chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(" ") ?? chat.username ?? "chat";
    chats.set(String(chat.id), { id: String(chat.id), type: chat.type, name });
  }
  return { ok: true, botUsername, chats: [...chats.values()] };
}
