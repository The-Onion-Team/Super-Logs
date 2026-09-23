import { useCallback, useEffect, useState } from "preact/hooks";
import { api, errorMessage, type NotificationChannel } from "../api";
import { ErrorNote, relative } from "./bits";

const MIN_LEVELS = [
  { value: "warning", label: "Warnings and above", hint: "Everything Super-Logs opens an incident for." },
  { value: "error", label: "Errors and above", hint: "Skips slow-response and other warnings." },
  { value: "critical", label: "Critical only", hint: "The 3am list." },
] as const;

/**
 * Telegram setup for one project. The bot token is write-only: the server
 * returns the bot id so we can show which bot is connected, never the secret,
 * so the field stays empty on an edit and an empty submit keeps what is stored.
 */
export function Notifications({ projectId }: { projectId: string }) {
  const [channel, setChannel] = useState<NotificationChannel | null | undefined>(undefined);
  const [apiBase, setApiBase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api<{ channels: NotificationChannel[]; telegramApiBaseUrl: string | null }>(
        `/projects/${projectId}/notifications`,
      );
      setChannel(result.channels.find((c) => c.kind === "telegram") ?? null);
      setApiBase(result.telegramApiBaseUrl);
    } catch (err) {
      setError(errorMessage(err));
      setChannel(null);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (kind: "save" | "test" | "remove", fn: () => Promise<string | null>) => {
    setBusy(kind);
    setError(null);
    setStatus(null);
    try {
      setStatus(await fn());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (channel === undefined) return <p className="muted">Loading notifications…</p>;

  const configured = channel !== null;

  return (
    <section className="notifications">
      <h3>Telegram alerts</h3>
      <p className="muted">
        When this project opens an incident, Super-Logs sends the error, where it happened and a link back here — at most one message per
        incident every 15 minutes, however many times it fires.
      </p>

      {apiBase && (
        <p className="warn-note" role="alert">
          Messages are being sent to <code>{apiBase}</code>, not to Telegram. Anything that answers there will report success even though
          nothing arrives in your chat. Clear <code>SUPER_LOGS_TELEGRAM_API_BASE_URL</code> and restart to use Telegram itself.
        </p>
      )}

      <ErrorNote message={error} />
      {status && (
        <p className="ok-note" role="status">
          {status}
        </p>
      )}

      {configured && (
        <div className="channel-state">
          <span className={`dot ${channel.enabled ? (channel.lastError ? "dot-bad" : "dot-ok") : "dot-off"}`} aria-hidden="true" />
          <div>
            <strong>{channel.enabled ? "Sending" : "Paused"}</strong> to <code>{channel.chatId}</code>
            {channel.botId && <span className="muted"> via bot {channel.botId}</span>}
            <div className="muted small-text">
              {channel.lastError ? (
                <>Last attempt failed: {channel.lastError}</>
              ) : channel.lastOkAt ? (
                <>Last message delivered {relative(channel.lastOkAt)}.</>
              ) : (
                <>Nothing sent yet — use “Send test message” to check it.</>
              )}
            </div>
          </div>
        </div>
      )}

      <details className="setup-help" open={!configured || showHelp} onToggle={(event) => setShowHelp(event.currentTarget.open)}>
        <summary>How to get a bot token and chat id</summary>
        <ol className="setup-steps">
          <li>
            In Telegram, message{" "}
            <a href="https://t.me/BotFather" target="_blank" rel="noreferrer noopener">
              @BotFather
            </a>{" "}
            and send <code>/newbot</code>. Copy the token he replies with.
          </li>
          <li>
            Decide where alerts should land, and let the bot see one message there — Telegram hides a chat until it has:
            <ul>
              <li>
                <strong>A group</strong> (best — the whole team sees it): create it, add your bot, send any message.
              </li>
              <li>
                <strong>Yourself</strong>: open the chat with your bot and press <em>Start</em>.
              </li>
              <li>
                <strong>A channel</strong>: add the bot as an admin, then post once.
              </li>
            </ul>
          </li>
          <li>
            Paste the token below and press <em>Find my chats</em> — Super-Logs will list what the bot can post to, so you do not have to
            hunt for the id yourself.
          </li>
        </ol>
      </details>

      <TelegramForm
        key={`${channel?.id ?? "new"}:${channel?.updatedAt ?? ""}`}
        projectId={projectId}
        channel={channel}
        busy={busy}
        onSaved={async (message) => {
          await load();
          setStatus(message);
        }}
        onError={setError}
        onBusy={setBusy}
      />

      {configured && (
        <div className="channel-actions">
          <button
            type="button"
            className="ghost"
            disabled={busy !== null}
            onClick={() =>
              run("test", async () => {
                await api(`/projects/${projectId}/notifications/telegram/test`, { method: "POST", body: {} });
                await load();
                return "Test message sent — check Telegram.";
              })
            }
          >
            {busy === "test" ? "Sending…" : "Send test message"}
          </button>
          <button
            type="button"
            className="danger"
            disabled={busy !== null}
            onClick={() => {
              if (!confirm("Remove Telegram alerts for this project? Incidents will stop being sent there.")) return;
              void run("remove", async () => {
                await api(`/projects/${projectId}/notifications/telegram`, { method: "DELETE" });
                setChannel(null);
                return "Telegram alerts removed.";
              });
            }}
          >
            Remove
          </button>
        </div>
      )}
    </section>
  );
}

function TelegramForm({
  projectId,
  channel,
  busy,
  onSaved,
  onError,
  onBusy,
}: {
  projectId: string;
  channel: NotificationChannel | null;
  busy: "save" | "test" | "remove" | null;
  onSaved: (message: string) => Promise<void>;
  onError: (message: string | null) => void;
  onBusy: (busy: "save" | "test" | "remove" | null) => void;
}) {
  const [noChatsFor, setNoChatsFor] = useState<string | null>(null);
  const onNoChats = setNoChatsFor;
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState(channel?.chatId ?? "");
  const [minLevel, setMinLevel] = useState<NotificationChannel["minLevel"]>(channel?.minLevel ?? "warning");
  const [enabled, setEnabled] = useState(channel?.enabled ?? true);
  const [found, setFound] = useState<{ id: string; label: string }[] | null>(null);
  const [looking, setLooking] = useState(false);

  // The fields start from whatever is stored. The parent remounts this form
  // when that changes, which is also what clears the token box after a save —
  // simpler than an effect that reaches in and overwrites what is typed.
  /**
   * Asks our server to look the chats up. It goes through the Telegram API
   * base Super-Logs is configured with, so a mirror or an outbound proxy keeps
   * working, and it does not need `api.telegram.org` in the page's CSP.
   */
  const findChats = async () => {
    onError(null);
    setNoChatsFor(null);
    setLooking(true);
    setFound(null);
    try {
      const result = await api<{ botUsername: string; chats: { id: string; type: string; name: string }[] }>(
        `/projects/${projectId}/notifications/telegram/discover`,
        { method: "POST", body: { botToken: token.trim() } },
      );
      setFound(result.chats.map((chat) => ({ id: chat.id, label: `${chat.name} (${chat.type})` })));
      // Telegram reveals a chat only once the bot has received a message
      // there, so an empty list is the normal first answer, not a failure.
      onNoChats(result.chats.length === 0 ? result.botUsername : null);
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setLooking(false);
    }
  };

  return (
    <form
      className="channel-form"
      onSubmit={(event) => {
        event.preventDefault();
        onBusy("save");
        onError(null);
        void (async () => {
          try {
            await api(`/projects/${projectId}/notifications/telegram`, {
              method: "PUT",
              body: { botToken: token.trim(), chatId: chatId.trim(), minLevel, enabled },
            });
            await onSaved(channel ? "Saved." : "Telegram connected. Send a test message to be sure.");
          } catch (err) {
            onError(errorMessage(err));
          } finally {
            onBusy(null);
          }
        })();
      }}
    >
      <label>
        <span>Bot token</span>
        <input
          type="password"
          value={token}
          autoComplete="off"
          spellcheck={false}
          onInput={(event) => setToken(event.currentTarget.value)}
          placeholder={channel?.botId ? `Stored — bot ${channel.botId}. Leave empty to keep it.` : "123456789:AA…"}
          aria-describedby="token-hint"
        />
        <small id="token-hint" className="muted">
          From @BotFather. Stored on your server and never shown again.
        </small>
      </label>

      <div className="find-chats">
        <button type="button" className="ghost small" disabled={!token.trim() || looking} onClick={() => void findChats()}>
          {looking ? "Asking Telegram…" : "Find my chats"}
        </button>
        {noChatsFor && (
          <p className="hint-note">
            <strong>@{noChatsFor}</strong> is a real bot and the token works — it just has not received a message yet, so Telegram will not
            reveal any chat.{" "}
            <a href={`https://t.me/${noChatsFor}`} target="_blank" rel="noreferrer noopener">
              Open the chat with @{noChatsFor}
            </a>{" "}
            and press <em>Start</em>, or add it to a group and post there. Then press <em>Find my chats</em> again.
          </p>
        )}
        {found && found.length > 0 && chatId.trim() && !found.some((chat) => chat.id === chatId.trim()) && (
          <p className="hint-note">
            The chat id in the field below (<code>{chatId.trim()}</code>) is not one this bot can reach. Pick one of these instead, or
            messages will be rejected.
          </p>
        )}
        {found && found.length > 0 && (
          <div className="found-chats">
            {found.map((chat) => (
              <button key={chat.id} type="button" className="ghost small" onClick={() => setChatId(chat.id)}>
                {chat.label} · <code>{chat.id}</code>
              </button>
            ))}
          </div>
        )}
      </div>

      <label>
        <span>Chat id</span>
        <input
          value={chatId}
          required
          maxLength={100}
          spellcheck={false}
          onInput={(event) => setChatId(event.currentTarget.value)}
          placeholder="-1001234567890 or @yourchannel"
        />
        <small className="muted">Group ids are negative. A public channel can be given as @name.</small>
      </label>

      <label>
        <span>Send me</span>
        <select value={minLevel} onChange={(event) => setMinLevel(event.currentTarget.value as NotificationChannel["minLevel"])}>
          {MIN_LEVELS.map((level) => (
            <option key={level.value} value={level.value}>
              {level.label}
            </option>
          ))}
        </select>
        <small className="muted">{MIN_LEVELS.find((level) => level.value === minLevel)?.hint}</small>
      </label>

      <label className="checkbox">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} />
        <span>Send alerts to this chat</span>
      </label>

      <button type="submit" disabled={busy !== null || !chatId.trim() || (!channel && !token.trim())}>
        {busy === "save" ? "Saving…" : channel ? "Save changes" : "Connect Telegram"}
      </button>
    </form>
  );
}
