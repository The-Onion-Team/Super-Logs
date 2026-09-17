import type { ClientInfo } from "@super-logs/shared";

/** Coarse, non-identifying browser facts, parsed once per page. */
export function clientInfo(): ClientInfo {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const ua = nav?.userAgent ?? "";
  const info: ClientInfo = { ...parseUserAgent(ua), userAgent: ua.slice(0, 300) || undefined };
  if (typeof window !== "undefined") {
    info.viewport = `${window.innerWidth}x${window.innerHeight}`;
    if (window.screen) info.screen = `${window.screen.width}x${window.screen.height}@${window.devicePixelRatio || 1}`;
  }
  if (nav?.language) info.language = nav.language;
  return info;
}

export function parseUserAgent(ua: string): Pick<ClientInfo, "browser" | "browserVersion" | "os" | "deviceClass"> {
  const match = (re: RegExp) => ua.match(re)?.[1];
  let browser: string | undefined;
  let browserVersion: string | undefined;
  const pairs: [string, RegExp][] = [
    ["Edge", /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ["Opera", /(?:OPR|Opera)\/([\d.]+)/],
    ["Samsung Internet", /SamsungBrowser\/([\d.]+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/([\d.]+)/],
    ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
    ["Safari", /Version\/([\d.]+).*Safari/],
  ];
  for (const [name, re] of pairs) {
    const version = match(re);
    if (version) {
      browser = name;
      browserVersion = version.split(".").slice(0, 2).join(".");
      break;
    }
  }

  let os: string | undefined;
  if (/Windows NT/.test(ua)) os = "Windows";
  else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if (/Mac OS X|Macintosh/.test(ua)) os = "macOS";
  else if (/Linux/.test(ua)) os = "Linux";

  let deviceClass: ClientInfo["deviceClass"] = ua ? "desktop" : "unknown";
  if (/bot|crawl|spider|slurp|headless/i.test(ua)) deviceClass = "bot";
  else if (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua)) deviceClass = "tablet";
  else if (/Mobi|iPhone|iPod|Android.*Mobile/i.test(ua)) deviceClass = "mobile";

  return { browser, browserVersion, os, deviceClass };
}
