// The only outbound code in the application. Tested against a real HTTP server
// on the loopback address, so the request is genuinely exercised without
// anything leaving the machine.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { SUMMARY_SYSTEM_PROMPT } from "../shared/ai-summary";
import { aiConfigured, aiStatus, endpointProblem, readAiSettings, requestSummary, settingsPathIn, writeAiSettings } from "./ai";
import type { AiSettings } from "./ai";

const dir = mkdtempSync(join(tmpdir(), "spacewise-ai-"));
after(() => rmSync(dir, { recursive: true, force: true }));

interface Seen {
  body: string;
  auth: string | undefined;
  url: string;
}

function startServer(reply: (seen: Seen) => { status: number; body: string }) {
  return new Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }>((resolve) => {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const entry: Seen = { body, auth: req.headers.authorization, url: req.url ?? "" };
        seen.push(entry);
        const out = reply(entry);
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(out.body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const completion = (text: string): string => JSON.stringify({ choices: [{ message: { content: text } }] });

const settingsFor = (baseUrl: string): AiSettings => ({ baseUrl, model: "a-model", apiKey: "a-key" });

describe("where a summary may be sent", () => {
  it("refuses to send anything until an endpoint is given", () => {
    assert.match(String(endpointProblem("")), /no endpoint/);
  });

  it("refuses something that is not an address at all", () => {
    assert.match(String(endpointProblem("not a url")), /not a valid address/);
  });

  it("insists on https for anything remote", () => {
    assert.match(String(endpointProblem("http://api.example.com/v1")), /has to use https/);
    assert.match(String(endpointProblem("ftp://api.example.com")), /start with https/);
    assert.equal(endpointProblem("https://api.example.com/v1"), null);
  });

  it("allows plain http on the loopback address, for a model running on this machine", () => {
    assert.equal(endpointProblem("http://127.0.0.1:11434/v1"), null);
    assert.equal(endpointProblem("http://localhost:1234/v1"), null);
  });

  it("still refuses plain http anywhere else", () => {
    assert.match(String(endpointProblem("http://192.168.1.10:1234/v1")), /has to use https/);
  });
});

describe("settings", () => {
  const file = settingsPathIn(join(dir, "settings"));

  it("treats a missing file as no settings, so the feature is off", () => {
    assert.deepEqual(readAiSettings(file), { baseUrl: "", model: "", apiKey: "" });
  });

  it("saves and reads back what was saved", () => {
    writeAiSettings(file, { baseUrl: "https://api.example.com/v1", model: "m", apiKey: "k" });
    assert.deepEqual(readAiSettings(file), { baseUrl: "https://api.example.com/v1", model: "m", apiKey: "k" });
  });

  it("changes only what it is given", () => {
    writeAiSettings(file, { baseUrl: "https://api.example.com/v1", model: "m", apiKey: "k" });
    const after = writeAiSettings(file, { model: "another" });
    assert.equal(after.model, "another");
    assert.equal(after.apiKey, "k", "the key should survive a change of model");
  });

  it("is only configured when the address, the model and a key are all there", () => {
    assert.equal(aiConfigured({ baseUrl: "https://x/v1", model: "m", apiKey: "k" }), true);
    assert.equal(aiConfigured({ baseUrl: "https://x/v1", model: "", apiKey: "k" }), false);
    assert.equal(aiConfigured({ baseUrl: "https://x/v1", model: "m", apiKey: "" }), false);
    assert.equal(aiConfigured({ baseUrl: "http://example.com", model: "m", apiKey: "k" }), false);
  });

  it("never hands the key to the interface", () => {
    const status = aiStatus({ baseUrl: "https://x/v1", model: "m", apiKey: "SECRET-KEY" });
    assert.equal(status.hasKey, true, "the interface may know that one exists");
    assert.ok(!JSON.stringify(status).includes("SECRET-KEY"), "but never the key itself");
    assert.equal(Object.prototype.hasOwnProperty.call(status, "apiKey"), false);
  });
});

describe("asking for a summary", () => {
  it("sends the message and the standing instructions, and returns the reply", async () => {
    const server = await startServer(() => ({ status: 200, body: completion("  Your projects hold 400 MB.  ") }));
    try {
      const message = "SpaceWise storage summary\n\nFiles 11,072\n";
      const out = await requestSummary(message, settingsFor(server.url));
      assert.equal(out.ok, true);
      assert.equal(out.text, "Your projects hold 400 MB.", "the reply is trimmed");

      assert.equal(server.seen.length, 1);
      const sent = JSON.parse(server.seen[0].body) as {
        model: string;
        messages: { role: string; content: string }[];
        max_tokens: number;
      };
      assert.equal(server.seen[0].url, "/chat/completions");
      assert.equal(server.seen[0].auth, "Bearer a-key");
      assert.equal(sent.model, "a-model");
      assert.equal(sent.max_tokens, 400, "the reply is bounded");
      assert.equal(sent.messages[0].role, "system");
      assert.equal(sent.messages[0].content, SUMMARY_SYSTEM_PROMPT, "the safety instructions are always sent");
      assert.equal(sent.messages[1].content, message, "and exactly the message that was approved, nothing more");
    } finally {
      await server.close();
    }
  });

  it("reports how much was sent", async () => {
    const server = await startServer(() => ({ status: 200, body: completion("ok") }));
    try {
      const out = await requestSummary("12345", settingsFor(server.url));
      assert.equal(out.bytes, 5);
    } finally {
      await server.close();
    }
  });

  it("does not send at all when the message is larger than the ceiling", async () => {
    const server = await startServer(() => ({ status: 200, body: completion("should not happen") }));
    try {
      const out = await requestSummary("x".repeat(9 * 1024), settingsFor(server.url));
      assert.equal(out.ok, false);
      assert.match(out.error, /larger than a summary is allowed to send/);
      assert.equal(server.seen.length, 0, "nothing may be sent, so nothing was");
    } finally {
      await server.close();
    }
  });

  it("does not send an empty message", async () => {
    const server = await startServer(() => ({ status: 200, body: completion("no") }));
    try {
      const out = await requestSummary("", settingsFor(server.url));
      assert.equal(out.ok, false);
      assert.match(out.error, /nothing to summarise/);
      assert.equal(server.seen.length, 0);
    } finally {
      await server.close();
    }
  });

  it("refuses a remote plain-http endpoint before it tries", async () => {
    const out = await requestSummary("hello", settingsFor("http://api.example.com/v1"));
    assert.equal(out.ok, false);
    assert.match(out.error, /has to use https/);
  });

  it("says what the endpoint answered when it is not happy", async () => {
    const server = await startServer(() => ({ status: 401, body: JSON.stringify({ error: "no" }) }));
    try {
      const out = await requestSummary("hello", settingsFor(server.url));
      assert.equal(out.ok, false);
      assert.match(out.error, /answered 401/);
    } finally {
      await server.close();
    }
  });

  it("copes with a reply that is not the shape it expects", async () => {
    const server = await startServer(() => ({ status: 200, body: JSON.stringify({ unexpected: true }) }));
    try {
      const out = await requestSummary("hello", settingsFor(server.url));
      assert.equal(out.ok, false);
      assert.match(out.error, /no text in it/);
    } finally {
      await server.close();
    }
  });

  it("copes with a reply that is not JSON at all", async () => {
    const server = await startServer(() => ({ status: 200, body: "<html>nope</html>" }));
    try {
      const out = await requestSummary("hello", settingsFor(server.url));
      assert.equal(out.ok, false);
      assert.match(out.error, /not readable/);
    } finally {
      await server.close();
    }
  });

  it("says so when the endpoint cannot be reached at all", async () => {
    // A port nothing is listening on.
    const out = await requestSummary("hello", settingsFor("http://127.0.0.1:9/v1"));
    assert.equal(out.ok, false);
    assert.match(out.error, /could not reach the endpoint/);
  });

  it("will not send when there is no key", async () => {
    const server = await startServer(() => ({ status: 200, body: completion("no") }));
    try {
      const out = await requestSummary("hello", { baseUrl: server.url, model: "m", apiKey: "  " });
      assert.equal(out.ok, false);
      assert.equal(server.seen.length, 0);
    } finally {
      await server.close();
    }
  });
});

describe("requestSummary: what it reports when the endpoint refuses", () => {
  // A refused request is the common failure in practice, and the status code on
  // its own does not say what to fix. Providers put the reason in the body, so
  // the body is carried through rather than thrown away.
  it("carries the provider's own explanation, not just the status", async () => {
    const server = await startServer(() => ({
      status: 400,
      body: JSON.stringify({ error: { message: "gpt-nonsense is not a valid model ID", type: "invalid_request_error" } }),
    }));
    try {
      const out = await requestSummary("hello", settingsFor(server.url));
      assert.equal(out.ok, false);
      assert.match(out.error, /answered 400/);
      assert.match(out.error, /gpt-nonsense is not a valid model ID/, "the reason has to reach the interface to be any use");
    } finally {
      await server.close();
    }
  });

  it("still says something when the refusal is not JSON", async () => {
    const server = await startServer(() => ({ status: 502, body: "<html><body>Bad gateway</body></html>" }));
    try {
      const out = await requestSummary("hello", settingsFor(server.url));
      assert.match(out.error, /answered 502/);
      assert.match(out.error, /Bad gateway/);
    } finally {
      await server.close();
    }
  });

  it("bounds a refusal that answers with a wall of text", async () => {
    const server = await startServer(() => ({ status: 500, body: "x".repeat(20000) }));
    try {
      const out = await requestSummary("hello", settingsFor(server.url));
      assert.ok(out.error.length < 600, `the message is displayed, so it stays short; got ${out.error.length} characters`);
    } finally {
      await server.close();
    }
  });

  it("gives up waiting rather than asking forever", async () => {
    // An endpoint that accepts the connection and then never answers. The limit
    // is passed in so that proving this does not take two minutes.
    const never: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    const out = await requestSummary("hello", settingsFor("http://127.0.0.1:9/v1"), never, 30);
    assert.equal(out.ok, false);
    assert.match(out.error, /did not answer within/);
  });
});
