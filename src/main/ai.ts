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

// A ceiling on waiting, not an expectation. Without it an endpoint that accepts
// the connection and then never answers leaves the sheet saying "asking"
// forever, with no way out but closing it.
const SUMMARY_TIMEOUT_MS = 120_000;

// An error reply is displayed, so it is bounded. Providers put the useful part
// first, and a wall of text is not an explanation.
const MAX_DETAIL = 300;

// A refusal that came from upstream is worth another try.
//
// Gateways report an unavailable provider as a 4xx, and the same request
// against the same model often succeeds a moment later -- measured at two
// failures in three against a free model on OpenRouter, on requests that were
// identical and perfectly well formed. That is not a bad request, and treating
// it as one turns a flaky provider into a dead end for the person.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 500;

// The status is usually enough. It is not for OpenRouter, which answers
// "Provider returned error" with a 400 when the model's own provider is
// unhappy -- a 400 that says nothing about the request. A refusal that is
// genuinely about the request (an unknown model, say) does not match this and
// is not retried.
function worthRetrying(status: number, detail: string): boolean {
  if (RETRYABLE_STATUS.has(status)) return true;
  return /provider returned error|provider error|upstream/i.test(detail);
}

// Whatever the endpoint said when it refused, in one line.
//
// Most providers answer with JSON carrying a message -- OpenRouter and OpenAI
// both put theirs at error.message -- and a provider that answers with plain
// text is no less informative for it. Reporting the status alone, as this did at
// first, leaves someone looking at "400" with no way to find out what was wrong
// with a request that was, after all, accepted by the network.
function explain(raw: string): string {
  const text = raw.trim();
  if (text === "") return "";
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const inner =
      typeof parsed.error === "object" && parsed.error !== null
        ? (parsed.error as { message?: unknown }).message
        : parsed.error;
    const candidate = typeof inner === "string" ? inner : parsed.message;
    if (typeof candidate === "string" && candidate.trim() !== "") message = candidate.trim();
  } catch {
    // Not JSON. The text itself is the explanation.
  }
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL)}…` : flat;
}

export async function requestSummary(
  message: string,
  settings: AiSettings,
  fetchImpl: typeof fetch = fetch,
  // Injectable so that the wait can be tested without waiting two minutes. It is
  // here for the same reason `fetchImpl` is.
  timeoutMs: number = SUMMARY_TIMEOUT_MS,
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

  // One attempt, kept separate so that a failure from upstream can be tried
  // again without repeating the checks above.
  const once = async (): Promise<{ outcome: SummaryOutcome; retryable: boolean }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey.trim()}` },
        signal: controller.signal,
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
      clearTimeout(timer);
      const why = controller.signal.aborted
        ? `the endpoint did not answer within ${timeoutMs / 1000} s`
        : `could not reach the endpoint: ${String((err as Error)?.message ?? err)}`;
      // A connection that failed is worth one more try. A timeout is not: the
      // endpoint has already had its whole allowance.
      return { outcome: { ok: false, text: "", error: why, bytes: size }, retryable: !controller.signal.aborted };
    }

    clearTimeout(timer);

    if (!response.ok) {
      // The provider's own explanation is the most useful thing on this path, so
      // it is carried through rather than replaced by the status code. Nothing is
      // guessed at: whatever the endpoint said is shown, bounded.
      let detail = "";
      try {
        detail = explain(await response.text());
      } catch {
        // Nothing readable came back, so the status is all there is to report.
      }
      return {
        outcome: {
          ok: false,
          text: "",
          error: `the endpoint answered ${response.status}${detail === "" ? "" : `: ${detail}`}`,
          bytes: size,
        },
        retryable: worthRetrying(response.status, detail),
      };
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch {
      return { outcome: { ok: false, text: "", error: "the reply could not be read", bytes: size }, retryable: false };
    }
    if (encoder.encode(raw).length > MAX_REPLY_BYTES) {
      return { outcome: { ok: false, text: "", error: "the reply was far larger than a summary should be", bytes: size }, retryable: false };
    }

    try {
      const parsed = JSON.parse(raw) as { choices?: { message?: { content?: string; reasoning?: string } }[] };
      const reply = parsed.choices?.[0]?.message;
      const text = reply?.content;
      if (typeof text !== "string" || text.trim() === "") {
        // A reasoning model can answer happily and put everything in a separate
        // field, leaving the answer empty. That is worth saying, because it is
        // the difference between "your request was wrong" and "this model does
        // not answer the way this feature needs".
        const onlyReasoning = typeof reply?.reasoning === "string" && reply.reasoning.trim() !== "";
        return {
          outcome: {
            ok: false,
            text: "",
            error: onlyReasoning
              ? "the reply contained only the model's reasoning and no summary; try a different model"
              : "the reply had no text in it",
            bytes: size,
          },
          retryable: false,
        };
      }
      return { outcome: { ok: true, text: text.trim(), error: "", bytes: size }, retryable: false };
    } catch {
      return { outcome: { ok: false, text: "", error: "the reply was not readable", bytes: size }, retryable: false };
    }
  };

  let outcome: SummaryOutcome = { ok: false, text: "", error: "no attempt was made", bytes: size };
  let tries = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    tries = attempt;
    const tried = await once();
    if (tried.outcome.ok) return tried.outcome;
    outcome = tried.outcome;
    if (!tried.retryable || attempt === MAX_ATTEMPTS) break;
    await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS * attempt));
  }

  // Say that it was tried more than once, so that an unreliable provider reads
  // as unreliable rather than as something the person got wrong.
  return tries > 1 ? { ...outcome, error: `${outcome.error} (after ${tries} attempts)` } : outcome;
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
