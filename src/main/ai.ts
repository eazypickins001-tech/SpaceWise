// The optional storage summary.
//
// This is the only code in the application that talks to anything outside the
// machine. It is deliberately small, off by default, and it is handed the exact
// text that was shown to the person for approval -- nothing else in the
// application gives it a path, a file name or a file's contents.
//
// No `electron` import here on purpose: the file path is passed in, so all of
// this can be tested, including the request, against a local server.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SUMMARY_MAX_BYTES, SUMMARY_SYSTEM_PROMPT } from "../shared/ai-summary";

export interface AiSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
}

const BLANK: AiSettings = { baseUrl: "", model: "", apiKey: "" };

export function settingsPathIn(userData: string): string {
  return join(userData, "ai-summary.json");
}

export function readAiSettings(file: string): AiSettings {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<AiSettings>;
    return {
      baseUrl: String(raw.baseUrl ?? ""),
      model: String(raw.model ?? ""),
      apiKey: String(raw.apiKey ?? ""),
    };
  } catch {
    // Missing or damaged settings are simply no settings: the feature is off.
    return { ...BLANK };
  }
}

export function writeAiSettings(file: string, next: Partial<AiSettings>): AiSettings {
  const merged: AiSettings = { ...readAiSettings(file), ...next };
  mkdirSync(dirname(file), { recursive: true });
  // Owner-only, because it holds a key.
  writeFileSync(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

// Where a summary may be sent. Anything remote must be https: a storage summary
// is not worth sending in the clear. A local model over plain http is allowed on
// the loopback address only, because that never leaves the machine.
export function endpointProblem(baseUrl: string): string | null {
  const raw = String(baseUrl ?? "").trim();
  if (raw === "") return "no endpoint is configured";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "that is not a valid address";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:") {
    const host = url.hostname;
    if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]") return null;
    return "a remote endpoint has to use https";
  }
  return "the address has to start with https://";
}

export function aiConfigured(settings: AiSettings): boolean {
  return endpointProblem(settings.baseUrl) === null && settings.model.trim() !== "" && settings.apiKey.trim() !== "";
}

export interface SummaryOutcome {
  ok: boolean;
  text: string;
  error: string;
  // How much was sent, so the interface can say so afterwards.
  bytes: number;
}

const MAX_REPLY_BYTES = 16 * 1024;

export async function requestSummary(
  message: string,
  settings: AiSettings,
  fetchImpl: typeof fetch = fetch,
): Promise<SummaryOutcome> {
  const problem = endpointProblem(settings.baseUrl);
  if (problem !== null) return { ok: false, text: "", error: problem, bytes: 0 };
  if (settings.model.trim() === "" || settings.apiKey.trim() === "") {
    return { ok: false, text: "", error: "the endpoint is not fully configured", bytes: 0 };
  }

  const body = typeof message === "string" ? message : "";
  const encoder = new TextEncoder();
  const size = encoder.encode(body).length;
  if (size === 0) return { ok: false, text: "", error: "there is nothing to summarise", bytes: 0 };
  // The ceiling is enforced here as well as where the message is built, so a
  // caller cannot decide to send more than this feature is allowed to send.
  if (size > SUMMARY_MAX_BYTES) {
    return { ok: false, text: "", error: "that message is larger than a summary is allowed to send", bytes: size };
  }

  const url = settings.baseUrl.trim().replace(/\/+$/, "") + "/chat/completions";
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey.trim()}` },
      body: JSON.stringify({
        model: settings.model.trim(),
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: body },
        ],
        max_tokens: 400,
        temperature: 0.2,
      }),
    });
  } catch (err) {
    return { ok: false, text: "", error: `could not reach the endpoint: ${String((err as Error)?.message ?? err)}`, bytes: size };
  }

  if (!response.ok) return { ok: false, text: "", error: `the endpoint answered ${response.status}`, bytes: size };

  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return { ok: false, text: "", error: "the reply could not be read", bytes: size };
  }
  if (encoder.encode(raw).length > MAX_REPLY_BYTES) {
    return { ok: false, text: "", error: "the reply was far larger than a summary should be", bytes: size };
  }

  try {
    const parsed = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
    const text = parsed.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text.trim() === "") {
      return { ok: false, text: "", error: "the reply had no text in it", bytes: size };
    }
    return { ok: true, text: text.trim(), error: "", bytes: size };
  } catch {
    return { ok: false, text: "", error: "the reply was not readable", bytes: size };
  }
}

// What the interface is allowed to know about the settings. The key itself is
// never sent to the renderer.
export interface AiStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  problem: string | null;
}

export function aiStatus(settings: AiSettings): AiStatus {
  return {
    configured: aiConfigured(settings),
    baseUrl: settings.baseUrl,
    model: settings.model,
    hasKey: settings.apiKey.trim() !== "",
    problem: endpointProblem(settings.baseUrl),
  };
}
