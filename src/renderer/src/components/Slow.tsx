// "Why is it slow?" — a ranked reading of six checks, the action each one implies,
// and a plain statement of anything that could not be measured.
//
// No score, no percentage of "faster", and nothing changed from here: the analysis
// hands over numbers and an id, and every sentence is built from those two. A
// reading that failed is listed as unread, never left out.
import { useEffect, useState } from "react";
import type { SlowAction, SlowFacts, SlowFinding } from "../../../shared/slow";
import type { Fmt, T } from "../lib/i18n";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

type State =
  | { is: "checking" }
  | { is: "failed"; reason: string }
  | { is: "done"; facts: SlowFacts; findings: SlowFinding[] };

// The name of each check, so "could not be read" says which one. Typed rather
// than built from a string, so a renamed key cannot slip through.
const CHECK_LABEL: Record<string, "slow.check.space" | "slow.check.memory" | "slow.check.disk" | "slow.check.io" | "slow.check.boot" | "slow.check.startup" | "slow.check.all"> = {
  space: "slow.check.space",
  memory: "slow.check.memory",
  disk: "slow.check.disk",
  io: "slow.check.io",
  boot: "slow.check.boot",
  startup: "slow.check.startup",
  all: "slow.check.all",
};

// One sentence per finding, built from the numbers the analysis measured.
function sentence(f: SlowFinding, t: T, fmt: Fmt): string {
  const v = f.values;
  switch (f.id) {
    case "space-full":
    case "space-tight":
      return t(`slow.finding.${f.id}`, {
        percentFree: v.percentFree,
        free: fmt.bytes(Number(v.freeBytes)),
        total: fmt.bytes(Number(v.totalBytes)),
      });
    case "memory-pressure":
      return t("slow.finding.memory-pressure", {
        percentCommitted: v.percentCommitted,
        limit: fmt.bytes(Number(v.limitBytes)),
      });
    case "disk-unhealthy": {
      // Only the numbers that were actually reported, so the sentence never says
      // "null errors".
      const extra: string[] = [];
      if (Number(v.readErrors) > 0) extra.push(t("slow.readErrors", { count: v.readErrors }));
      if (Number(v.wear) >= 80) extra.push(t("slow.wear", { percent: v.wear }));
      const base = t("slow.finding.disk-unhealthy", { status: v.status });
      return extra.length > 0 ? `${base} ${extra.join(" ")}` : base;
    }
    case "io-slow":
      return t("slow.finding.io-slow", { msPerTransfer: v.msPerTransfer, queue: v.queue });
    case "boot-slow":
      return t("slow.finding.boot-slow", { seconds: v.seconds });
    case "startup-busy":
      return t("slow.finding.startup-busy", { count: v.count });
  }
}

export function SlowSheet(p: {
  t: T;
  fmt: Fmt;
  // The storage actions only make sense once there is a scan to look at.
  hasScan: boolean;
  onClose: () => void;
  onLargest: () => void;
}) {
  const { t, fmt } = p;
  const [state, setState] = useState<State>({ is: "checking" });

  const run = (): void => {
    setState({ is: "checking" });
    void window.api
      .slowCheck()
      .then((r) => setState({ is: "done", facts: r.facts, findings: r.findings }))
      // A failed call says so and offers a retry, rather than sitting on
      // "Checking…" for ever or reporting a clean bill of health.
      .catch((e) => setState({ is: "failed", reason: String((e as Error)?.message ?? e) }));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => run(), []);

  const action = (a: SlowAction): void => {
    if (a.kind === "windows") {
      void window.api.openExternal("ms-settings:" + a.page);
      return;
    }
    p.onLargest();
  };

  const actionLabel = (a: SlowAction): string =>
    a.kind === "windows" ? t("slow.action.windows") : a.kind === "cleanup" ? t("slow.action.cleanup") : t("slow.action.largest");

  const missing = state.is === "done" ? Object.entries(state.facts.missing) : [];

  return (
    <Sheet wide onClose={p.onClose}>
      <header>
        <h2>{t("slow.title")}</h2>
      </header>
      <div className="body">
        <p className="dim" style={{ marginTop: 0 }}>
          {t("slow.lead")}
        </p>

        {state.is === "checking" && <p className="slow-working">{t("slow.checking")}</p>}

        {state.is === "failed" && (
          <div className="problem" role="alert">
            <p>{t("slow.failed", { why: state.reason })}</p>
            <button className="btn" onClick={run}>
              <Icon name="rescan" />
              {t("slow.retry")}
            </button>
          </div>
        )}

        {state.is === "done" && (
          <>
            {state.findings.length === 0 ? (
              <p>{t("slow.nothing")}</p>
            ) : (
              <ul className="slow-list">
                {state.findings.map((f) => (
                  <li key={f.id} className={"slow-row " + f.severity}>
                    <span className={"slow-dot " + f.severity} aria-hidden="true" />
                    <div className="slow-what">
                      <p>
                        {/* The mark alone would leave the ranking to colour, so the
                            rank is also a word. */}
                        <span className="slow-sev">{t(`slow.sev.${f.severity}`)}</span>
                        {sentence(f, t, fmt)}
                      </p>
                      {f.action && (f.action.kind === "windows" || p.hasScan) && (
                        <button className="btn quiet" onClick={() => action(f.action!)}>
                          {actionLabel(f.action)}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {missing.length > 0 && (
              <ul className="slow-missing">
                {missing.map(([name, why]) => (
                  <li key={name}>
                    <strong>{t(CHECK_LABEL[name] ?? "slow.check.all")}:</strong> {why}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <footer>
        <button className="btn" autoFocus onClick={p.onClose}>
          {t("issues.close")}
        </button>
      </footer>
    </Sheet>
  );
}
