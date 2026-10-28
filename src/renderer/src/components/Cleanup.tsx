// The Clean up tab: what SpaceWise found, why it is a candidate, what removing
// it costs, and a deliberate review before anything happens.
//
// This is the only place in the interface that can move files. It follows the
// same order every time: pick, plan, revalidate, confirm, report. Nothing is
// preselected, nothing happens in the background, and a plan that changed under
// the user's feet is refused rather than acted on.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { CategoryId, Finding, Risk } from "../../../shared/storage-intelligence";
import { CATEGORIES, analyzeStorage, summarize } from "../../../shared/storage-intelligence";
import { actionLabel } from "../../../shared/cleanup";
import type { AuditRecord, CleanupPlan, CleanupProgress, CleanupRunResult } from "../../../shared/cleanup";
import type { Fmt, T } from "../lib/i18n";
import type { PaneProps } from "./Panels";
import { Icon } from "./Icon";
import { AiSummarySheet } from "./AiSummary";
import { ChatSheet } from "./Chat";
import { Sheet } from "./Sheet";

const GRID = "minmax(0, 1fr) 96px 86px 34px";

type Step =
  | { is: "idle" }
  | { is: "planning" }
  | { is: "review"; plan: CleanupPlan }
  | { is: "running"; plan: CleanupPlan }
  | { is: "result"; plan: CleanupPlan; result: CleanupRunResult };

function RiskTag({ risk, t }: { risk: Risk; t: T }): ReactNode {
  const tone = risk === "safe" ? "low" : risk === "low" ? "low" : "high";
  return (
    <span
      style={{
        border: "1px solid currentColor",
        padding: "0 4px",
        fontSize: 11.5,
        opacity: tone === "low" ? 0.85 : 1,
        whiteSpace: "nowrap",
      }}
    >
      {t(`cleanup.risk.${risk}`)}
    </span>
  );
}

// A local dialog. The one in App.tsx is not exported, and this tab keeps its own
export const CleanupPane = memo(function CleanupPane(p: PaneProps & { onRemoved: (ids: number[]) => void; onLicence: () => void }) {
  const { disk, fmt, t, version, onRemoved, onLicence } = p;
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [closed, setClosed] = useState<Set<CategoryId>>(() => new Set());
  const [permanent, setPermanent] = useState(false);
  const [step, setStep] = useState<Step>({ is: "idle" });
  // null means "not read yet". Reloaded after every run so the list is current.
  const [history, setHistory] = useState<AuditRecord[] | null>(null);
  // Anything that went wrong, shown rather than swallowed.
  const [problem, setProblem] = useState<string | null>(null);
  // How far a run has got, and whether a stop has been asked for. Kept apart
  // from `step` so the bar can move without changing which sheet is drawn.
  const [progress, setProgress] = useState<CleanupProgress | null>(null);
  const [stopping, setStopping] = useState(false);

  // The total arrives before the first item is touched, so the count and the bar
  // are honest from the start rather than only once the run has ended.
  useEffect(() => window.api.onCleanupProgress(setProgress), []);
  // The optional summary is opened by hand, never on its own.
  const [summaryOpen, setSummaryOpen] = useState(false);
  // Which finding the assistant is being asked about, by id.
  const [chat, setChat] = useState<number | null>(null);

  const openHistory = async (): Promise<void> => {
    try {
      setHistory(await window.api.cleanupHistory(20));
    } catch {
      setProblem(t("cleanup.failedCall"));
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const findings = useMemo(() => analyzeStorage(disk), [disk, version]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const groups = useMemo(() => summarize(findings), [findings]);
  const byId = useMemo(() => new Map(findings.map((f) => [f.id, f])), [findings]);

  const selectedFindings = findings.filter((f) => picked.has(f.id));
  const selectedBytes = selectedFindings.reduce((sum, f) => sum + f.bytes, 0);

  const toggleOne = (id: number): void =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleGroup = (ids: number[]): void =>
    setPicked((prev) => {
      const next = new Set(prev);
      const all = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  // Step 1 to 3: the candidates become a plan the main process has checked.
  const plan = async (): Promise<void> => {
    if (selectedFindings.length === 0) return;
    setProblem(null);
    setStep({ is: "planning" });
    const candidates = selectedFindings.map((f) => ({ id: f.id, path: f.path, bytes: f.bytes, risk: f.risk }));
    try {
      const built = await window.api.planCleanup(disk.t.root, candidates, permanent ? "delete" : "trash");
      setStep(built.items.length === 0 ? { is: "idle" } : { is: "review", plan: built });
    } catch {
      // Never leave the tab stuck on "checking" with no explanation.
      setProblem(t("cleanup.failedCall"));
      setStep({ is: "idle" });
    }
  };

  const run = async (built: CleanupPlan): Promise<void> => {
    setProgress(null);
    setStopping(false);
    setStep({ is: "running", plan: built });
    let result: CleanupRunResult;
    try {
      result = await window.api.runCleanup(built);
    } catch {
      // The action may or may not have run: say so instead of guessing.
      setProblem(t("cleanup.failedCall"));
      setStep({ is: "idle" });
      return;
    }
    // Only what actually went is taken off the tree on screen.
    const gone = new Set(result.outcomes.filter((o) => o.status === "removed").map((o) => o.path));
    const ids = built.items.filter((i) => gone.has(i.path)).map((i) => i.id);
    if (ids.length > 0) {
      onRemoved(ids);
      setPicked((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
    setStep({ is: "result", plan: built, result });
    setHistory(null);
  };

  // Closing the running sheet and stopping the run are the same act: the sheet
  // exists only to show the run, so there is nothing else "close" could mean.
  // The stop is read between items, so a removal already under way finishes and
  // everything untouched is reported as skipped rather than quietly dropped.
  const cancelRun = (): void => {
    setStopping(true);
    void window.api.cancelCleanup();
  };

  // A run that removes the last candidate still owes a report: it is the receipt for
  // something irreversible. This used to return on an empty list whatever the step
  // was, so a run that emptied the tab threw its own report away and left the person
  // looking at "nothing to suggest" with no word of what had been freed.
  if (findings.length === 0 && step.is === "idle") {
    return (
      <div className="pane">
        <div className="pane-empty">{t("cleanup.none")}</div>
      </div>
    );
  }

  const total = findings.reduce((sum, f) => sum + f.bytes, 0);

  return (
    <div className="pane">
      {problem ? (
        <div className="pane-note" style={{ color: "var(--red, #b3261e)" }}>
          {problem}
        </div>
      ) : null}
      <div className="pane-note">
        {findings.length === 0 ? (
          <strong>{t("cleanup.none")}</strong>
        ) : (
          <strong>{t("cleanup.note", { bytes: fmt.bytes(total), count: fmt.count(findings.length) })}</strong>
        )}
      </div>

      <div className="pane-bar">
        <button className="btn quiet" onClick={() => void openHistory()} disabled={step.is !== "idle"}>
          {t("cleanup.history")}
        </button>
        <button className="btn quiet" onClick={() => setSummaryOpen(true)} disabled={step.is !== "idle" || findings.length === 0}>
          {t("ai.title")}
        </button>
        <button
          className="btn quiet"
          onClick={() => setPicked(new Set(findings.map((f) => f.id)))}
          disabled={picked.size === findings.length}
        >
          {t("cleanup.selectAll")}
        </button>
        <span className="dim" style={{ marginLeft: "auto", marginRight: 8 }}>
          {t("cleanup.selected", { count: fmt.count(selectedFindings.length), bytes: fmt.bytes(selectedBytes) })}
        </span>
        <button className="btn" disabled={selectedFindings.length === 0 || step.is !== "idle"} onClick={() => void plan()}>
          <Icon name="scan" />
          {step.is === "planning" ? t("cleanup.planning") : t("cleanup.review")}
        </button>
      </div>

      <div className="thead" style={{ gridTemplateColumns: GRID }}>
        <button disabled>{t("col.name")}</button>
        <button disabled>{t("cleanup.riskTitle")}</button>
        <button disabled className="num sorted">
          {t("col.size")}
          <Icon name="sortDown" size={12} />
        </button>
        <button disabled />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {groups.map((g) => {
          const open = !closed.has(g.category);
          const all = g.ids.every((id) => picked.has(id));
          return (
            <div key={g.category}>
              <div
                className="trow group"
                role="row"
                aria-expanded={open}
                style={{ position: "relative", gridTemplateColumns: GRID, cursor: "pointer" }}
                onClick={() =>
                  setClosed((prev) => {
                    const next = new Set(prev);
                    if (next.has(g.category)) next.delete(g.category);
                    else next.add(g.category);
                    return next;
                  })
                }
              >
                <div className="cell-name">
                  <span className={"twist" + (open ? " open" : "")}>
                    <Icon name="chevron" size={12} />
                  </span>
                  <span className="text">{g.def.label}</span>
                  <span className="hint">{g.def.whyItGrows}</span>
                </div>
                <div style={{ padding: "0 8px" }}>
                  <RiskTag risk={g.def.risk} t={t} />
                </div>
                <div className="num">{fmt.bytes(g.bytes)}</div>
                <div style={{ padding: 0 }}>
                  <input
                    type="checkbox"
                    checked={all}
                    aria-label={g.def.label}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleGroup(g.ids)}
                  />
                </div>
              </div>

              {open &&
                g.ids.map((id) => {
                  const f = byId.get(id);
                  if (!f) return null;
                  return (
                    <div key={id} className="trow" role="row" style={{ position: "relative", gridTemplateColumns: GRID }}>
                      <div className="cell-name" title={`${f.reason}\n\n${f.consequence}`}>
                        <Icon name="folder" className="glyph" />
                        <span className="text">{disk.name(id)}</span>
                        <span className="sub">{f.reason}</span>
                        <button
                          className="btn quiet"
                          style={{ marginLeft: 8, fontSize: 11, padding: "0 6px" }}
                          title={t("ai.askTitle")}
                          onClick={() => setChat(id)}
                        >
                          {t("ai.askAbout")}
                        </button>
                      </div>
                      <div className="dim" style={{ padding: "0 8px", fontSize: 12 }}>
                        {g.def.regeneration}
                      </div>
                      <div className="num">{fmt.bytes(f.bytes)}</div>
                      <div style={{ padding: 0 }}>
                        <input
                          type="checkbox"
                          checked={picked.has(id)}
                          aria-label={disk.name(id)}
                          onChange={() => toggleOne(id)}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>

      {step.is === "review" && (
        <Sheet wide onClose={() => setStep({ is: "idle" })}>
          <header>
            <h2>{t("cleanup.reviewTitle")}</h2>
          </header>
          <div className="body">
            <p className="what">{t("cleanup.action")}: {actionLabel(step.plan.action)}</p>
            <p>{t("cleanup.planItems", { count: fmt.count(step.plan.items.length), bytes: fmt.bytes(step.plan.estimatedBytes) })}</p>
            <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0" }}>
              <input
                type="checkbox"
                checked={permanent}
                onChange={(e) => {
                  setPermanent(e.target.checked);
                  setStep({ is: "idle" });
                }}
              />
              {t("cleanup.permanent")}
            </label>
            <div style={{ maxHeight: 200, overflow: "auto", borderTop: "1px solid currentColor", paddingTop: 6 }}>
              {step.plan.items.map((i) => (
                <div key={i.id} className="dim" style={{ fontSize: 12, padding: "2px 0" }} title={i.path}>
                  {i.path}
                </div>
              ))}
            </div>
            {step.plan.rejected.length > 0 && (
              <>
                <h3 style={{ marginTop: 12 }}>{t("cleanup.refused")}</h3>
                <ul className="issue-list">
                  {step.plan.rejected.map((r, i) => (
                    <li key={i}>
                      {r.path}: {r.reason}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <footer>
            <button className="btn" onClick={() => setStep({ is: "idle" })}>
              {t("act.cancel")}
            </button>
            <button className="btn danger" autoFocus onClick={() => void run(step.plan)}>
              <Icon name="trash" />
              {t("cleanup.confirm", { count: fmt.count(step.plan.items.length) })}
            </button>
          </footer>
        </Sheet>
      )}

      {step.is === "running" && (
        <Sheet onClose={cancelRun}>
          <header>
            <h2>{t(stopping ? "scan.stopping" : "cleanup.running")}</h2>
          </header>
          <div className="body">
            {progress ? (
              <>
                <p className="what">{t("cleanup.progress", { done: fmt.count(progress.done), total: fmt.count(progress.total) })}</p>
                <div className="share" style={{ marginTop: 6 }}>
                  <span className="track" style={{ height: 10 }}>
                    <span
                      className="fill"
                      style={{ width: (progress.total > 0 ? progress.done / progress.total : 0) * 100 + "%", display: "block" }}
                    />
                  </span>
                </div>
                {progress.path ? (
                  <p className="dim" style={{ fontSize: 12, marginTop: 6, overflowWrap: "anywhere" }}>
                    <bdi>{progress.path}</bdi>
                  </p>
                ) : null}
              </>
            ) : (
              <p>{t("cleanup.planItems", { count: fmt.count(step.plan.items.length), bytes: fmt.bytes(step.plan.estimatedBytes) })}</p>
            )}
            <p className="dim" style={{ fontSize: 12 }}>
              {t("cleanup.closeStops")}
            </p>
          </div>
          <footer>
            <button className="btn" onClick={cancelRun} disabled={stopping} autoFocus>
              <Icon name="stop" />
              {t(stopping ? "scan.stopping" : "act.cancel")}
            </button>
          </footer>
        </Sheet>
      )}

      {chat !== null && byId.get(chat) && (
        <ChatSheet
          disk={disk}
          finding={byId.get(chat)!}
          category={CATEGORIES[byId.get(chat)!.category] ?? null}
          t={t}
          fmt={fmt}
          onClose={() => setChat(null)}
          onLicence={() => {
            setChat(null);
            onLicence();
          }}
        />
      )}

      {summaryOpen && (
        <AiSummarySheet
          disk={disk}
          findings={findings}
          t={t}
          fmt={fmt}
          onClose={() => setSummaryOpen(false)}
          onLicence={() => {
            setSummaryOpen(false);
            onLicence();
          }}
        />
      )}

      {history !== null && (
        <Sheet wide onClose={() => setHistory(null)}>
          <header>
            <h2>{t("cleanup.historyTitle")}</h2>
          </header>
          <div className="body">
            <p className="dim" style={{ fontSize: 12 }}>
              {t("cleanup.historyNote")}
            </p>
            {history.length === 0 ? (
              <p>{t("cleanup.historyNone")}</p>
            ) : (
              <div style={{ maxHeight: 260, overflow: "auto", borderTop: "1px solid currentColor", paddingTop: 6 }}>
                {history.map((r, i) => (
                  <div key={i} style={{ padding: "4px 0", borderBottom: "1px solid rgba(128,128,128,0.25)" }}>
                    <div>
                      {fmt.date(Math.floor(r.at / 1000))} · {actionLabel(r.action)}
                    </div>
                    <div className="dim" style={{ fontSize: 12 }}>
                      {r.scope}
                    </div>
                    <div className="dim" style={{ fontSize: 12 }}>
                      {t("cleanup.historySummary", { removed: fmt.count(r.removed), bytes: fmt.bytes(r.bytesFreed) })}
                      {r.partial ? ` · ${t("cleanup.historyLeft", { count: fmt.count(r.failed + r.skipped) })}` : ""}
                      {r.rejected.length > 0 && (
                        <details style={{ marginTop: 2 }}>
                          <summary style={{ cursor: "pointer" }}>
                            {t("cleanup.historyRejected", { count: fmt.count(r.rejected.length) })}
                          </summary>
                          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                            {r.rejected.map((x, j) => (
                              <li key={j}>
                                {x.path} — {x.reason}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <footer>
            <button className="btn" autoFocus onClick={() => setHistory(null)}>
              {t("cleanup.close")}
            </button>
          </footer>
        </Sheet>
      )}

      {step.is === "result" && (
        <Sheet wide onClose={() => setStep({ is: "idle" })}>
          <header>
            <h2>{t("cleanup.doneTitle")}</h2>
          </header>
          <div className="body">
            <p className="what">
              {t("cleanup.removed", {
                count: fmt.count(step.result.outcomes.filter((o) => o.status === "removed").length),
                bytes: fmt.bytes(step.result.record?.bytesFreed ?? 0),
              })}
            </p>
            <p>{step.result.record?.partial ? t("cleanup.partial") : t("cleanup.complete")}</p>
            <div style={{ maxHeight: 220, overflow: "auto", borderTop: "1px solid currentColor", paddingTop: 6 }}>
              {step.result.outcomes.map((o, i) => (
                <div key={i} className="dim" style={{ fontSize: 12, padding: "2px 0" }}>
                  <span style={{ opacity: o.status === "removed" ? 0.6 : 1 }}>
                    {o.status === "removed" ? "\u2713 " : o.status === "failed" ? "\u2717 " : "\u2013 "}
                    {o.path}
                    {o.error ? ` (${o.error})` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <footer>
            <button className="btn" autoFocus onClick={() => setStep({ is: "idle" })}>
              {t("cleanup.close")}
            </button>
          </footer>
        </Sheet>
      )}
    </div>
  );
});
