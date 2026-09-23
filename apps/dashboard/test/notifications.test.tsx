/** @jsxImportSource preact */
// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notifications } from "../src/components/Notifications";
import type { NotificationChannel } from "../src/api";

const CHANNEL: NotificationChannel = {
  id: "nch_1",
  kind: "telegram",
  enabled: true,
  minLevel: "warning",
  botId: "123456789",
  chatId: "-1001112223334",
  threadId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastOkAt: null,
  lastError: null,
};

let root: HTMLDivElement;

/** Replies to the dashboard's own API, which is all this component talks to. */
function stubApi(handler: (path: string, init: RequestInit | undefined) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const payload = handler(String(url), init);
      return new Response(JSON.stringify(payload ?? {}), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

/**
 * Retries until the condition holds. Loading a channel is effect → fetch →
 * json → setState → re-render, which is several ticks, so a fixed delay would
 * be either flaky or slow.
 */
async function waitFor<T>(condition: () => T | null | undefined | false, what = "condition"): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}\n--- rendered ---\n${root.textContent}\n--- buttons ---\n${[...root.querySelectorAll("button")].map((b) => `${b.textContent} disabled=${b.disabled}`).join(" | ")}`);
}

const has = (text: string) => () => (root.textContent ?? "").includes(text);
const button = (label: string) =>
  [...root.querySelectorAll("button")].find((element) => element.textContent?.includes(label)) as HTMLButtonElement | undefined;

/** Types into a controlled field the way a person would. */
async function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await waitFor(() => input.value === value, "the field to keep its value");
}

beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
});

describe("Telegram settings UI", () => {
  it("walks an operator through setup when nothing is configured", async () => {
    stubApi(() => ({ channels: [] }));
    render(<Notifications projectId="prj_1" />, root);
    await waitFor(has("Telegram alerts"), "the panel to load");

    const text = root.textContent ?? "";
    expect(text).toContain("@BotFather");
    // The instructions are open by default when there is nothing set up yet.
    expect(root.querySelector("details")?.open).toBe(true);
    expect(root.querySelector("button[type=submit]")?.textContent).toBe("Connect Telegram");
    // Nothing to test or remove before a channel exists.
    expect(text).not.toContain("Send test message");
  });

  it("cannot be submitted without a token on a first setup", async () => {
    stubApi(() => ({ channels: [] }));
    render(<Notifications projectId="prj_1" />, root);
    await waitFor(() => root.querySelector("button[type=submit]"), "the form");
    expect((root.querySelector("button[type=submit]") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows which bot and chat are connected, without the token", async () => {
    stubApi(() => ({ channels: [CHANNEL] }));
    render(<Notifications projectId="prj_1" />, root);
    await waitFor(has("Sending"), "the connected state");

    const text = root.textContent ?? "";
    expect(text).toContain("-1001112223334");
    expect(text).toContain("via bot 123456789");
    expect(text).toContain("Nothing sent yet");
    expect(text).toContain("Send test message");
    // The token field is empty and keeps the stored secret when left alone.
    const token = root.querySelector('input[type="password"]') as HTMLInputElement;
    expect(token.value).toBe("");
    expect(token.placeholder).toContain("Leave empty to keep it");
    expect(root.querySelector("button[type=submit]")?.textContent).toBe("Save changes");
  });

  it("surfaces a delivery failure rather than looking healthy", async () => {
    stubApi(() => ({ channels: [{ ...CHANNEL, lastError: "telegram chat not found" }] }));
    render(<Notifications projectId="prj_1" />, root);
    await waitFor(has("Last attempt failed: telegram chat not found"), "the failure notice");
    expect(root.querySelector(".dot-bad")).not.toBeNull();
  });

  it("reads as paused when the channel is switched off", async () => {
    stubApi(() => ({ channels: [{ ...CHANNEL, enabled: false }] }));
    render(<Notifications projectId="prj_1" />, root);
    await waitFor(has("Paused"), "the paused state");
    expect(root.querySelector(".dot-off")).not.toBeNull();
  });

  it("offers the discovered chats as buttons that fill the chat id", async () => {
    stubApi((path) =>
      path.endsWith("/discover")
        ? { botUsername: "fantaf1_logs_bot", chats: [{ id: "-1001112223334", type: "supergroup", name: "FantaF1 — alerts" }] }
        : { channels: [] },
    );
    render(<Notifications projectId="prj_1" />, root);
    const token = await waitFor(() => root.querySelector('input[type="password"]') as HTMLInputElement, "the token field");
    await type(token, "123456789:AAFakeTokenForTestsOnly-0123456789");

    await waitFor(() => button("Find my chats") && !button("Find my chats")!.disabled, "the lookup button to enable");
    button("Find my chats")!.click();

    const chat = await waitFor(() => root.querySelector(".found-chats button") as HTMLButtonElement, "the discovered chats");
    expect(chat.textContent).toContain("FantaF1 — alerts (supergroup)");
    chat.click();

    const chatId = root.querySelector('input[placeholder*="-1001234567890"]') as HTMLInputElement;
    await waitFor(() => chatId.value === "-1001112223334", "the chat id to be filled in");
  });

  it("links straight to the bot when it has not been messaged yet", async () => {
    stubApi((path) => (path.endsWith("/discover") ? { botUsername: "fantaf1_logs_bot", chats: [] } : { channels: [] }));
    render(<Notifications projectId="prj_1" />, root);
    const token = await waitFor(() => root.querySelector('input[type="password"]') as HTMLInputElement, "the token field");
    await type(token, "123456789:AAFakeTokenForTestsOnly-0123456789");

    await waitFor(() => button("Find my chats") && !button("Find my chats")!.disabled, "the lookup button to enable");
    button("Find my chats")!.click();
    await waitFor(has("has not received a message yet"), "the empty-result explanation");
    // The usual dead end is "go and find your bot"; a link removes the hunt.
    const link = root.querySelector(".hint-note a") as HTMLAnchorElement;
    expect(link.href).toBe("https://t.me/fantaf1_logs_bot");
  });

  it("flags a saved chat id the bot cannot actually reach", async () => {
    stubApi((path) =>
      path.endsWith("/discover")
        ? { botUsername: "fantaf1_logs_bot", chats: [{ id: "947616773", type: "private", name: "Borto" }] }
        : { channels: [{ ...CHANNEL, chatId: "-1001112223334" }], telegramApiBaseUrl: null },
    );
    render(<Notifications projectId="prj_1" />, root);
    const token = await waitFor(() => root.querySelector('input[type="password"]') as HTMLInputElement, "the token field");
    await type(token, "123456789:AAFakeTokenForTestsOnly-0123456789");
    await waitFor(() => button("Find my chats") && !button("Find my chats")!.disabled, "the lookup button");
    button("Find my chats")!.click();

    await waitFor(has("is not one this bot can reach"), "the mismatch warning");
    expect(root.textContent).toContain("-1001112223334");

    // Choosing the offered chat clears the warning.
    (root.querySelector(".found-chats button") as HTMLButtonElement).click();
    await waitFor(() => !(root.textContent ?? "").includes("is not one this bot can reach"), "the warning to clear");
  });

  it("warns when messages are not going to Telegram at all", async () => {
    stubApi(() => ({ channels: [CHANNEL], telegramApiBaseUrl: "http://127.0.0.1:39200" }));
    render(<Notifications projectId="prj_1" />, root);
    await waitFor(has("not to Telegram"), "the mirror warning");
    expect(root.textContent).toContain("http://127.0.0.1:39200");
    expect(root.querySelector(".warn-note")).not.toBeNull();
  });

  it("stays quiet when Telegram itself is the destination", async () => {
    stubApi(() => ({ channels: [CHANNEL], telegramApiBaseUrl: null }));
    render(<Notifications projectId="prj_1" />, root);
    await waitFor(has("Sending"), "the connected state");
    expect(root.querySelector(".warn-note")).toBeNull();
  });
});
