// The optional storage summary.
//
// Three things this deliberately does not do: it never starts on its own, it
// never sends anything the person has not seen, and it never produces a list of
// things to delete. What it produces is a description, shown as prose beside
// the findings, which cannot select or remove anything -- there is no code path
// from here to an action.
//
// The message is built by the same pure function the tests exercise, and it is
// displayed verbatim before the button that sends it.
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildSummaryPayload, relativeLabel } from "../../../shared/ai-summary";
import type { SummaryFact } from "../../../shared/ai-summary";
import type { AiStatusState, AiSummaryResult } from "../../../shared/types";
import type { Finding } from "../../../shared/storage-intelligence";
import { byType } from "../lib/analysis";
import type { Disk } from "../lib/disk";
import type { Fmt, T } from "../lib/i18n";
import { Sheet } from "./Sheet";
import { PremiumGate } from "./License";
import { Icon } from "./Icon";

interface Props {
  disk: Disk;
  findings: Finding[];
  t: T;
  fmt: Fmt;
  onClose: () => void;
  onLicence: () => void;
}

// The last segment of the scanned folder, which is all the message ever names.
function rootNameOf(root: string): string {
  const parts = root.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : root;
}

export function AiSummarySheet({ disk, findings, t, fmt, onClose, onLicence }: Props): React.JSX.Element {
  const [status, setStatus] = useState<AiStatusState | null>(null);
  // Off unless asked for. The person decides whether names travel.
  const [names, setNames] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiSummaryResult | null>(null);

  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  // Shown on the button after a save, because changing a model and seeing nothing
  // happen is indistinguishable from a save that failed.
  const [saved, setSaved] = useState(false);

  // Why the status could not be read. Without it a failed call left the sheet on
  // "Checking…" for ever, with no error and no way to try again.
  const [statusError, setStatusError] = useState("");

  const load = useCallback((): void => {
    setStatusError("");
    void window.api
      .aiStatus()
      .then((next) => {
        setStatus(next);
        setBaseUrl((was) => was || next.baseUrl);
        setModel((was) => was || next.model);
      })
      .catch((err) => setStatusError(String((err as Error)?.message ?? err)));
  }, []);

  useEffect(() => load(), [load]);

  const payload = useMemo(() => {
    const table = disk.t;
    const facts: SummaryFact[] = [...findings]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 40) // the payload caps this again; this only bounds the work
      .map((f) => ({
        label: relativeLabel(table.root, f.path),
        bytes: f.bytes,
        category: String(f.category),
        risk: String(f.risk),
      }));
    const types = byType(disk)
      .slice(0, 8)
      .map((row) => ({ ext: row.ext, bytes: row.bytes, count: row.files }));
    return buildSummaryPayload(
      {
        rootName: rootNameOf(table.root),
        files: table.files[0],
        dirs: table.dirs,
        bytes: table.size[0],
        errors: table.errors,
        facts,
        types,
        duplicates: null,
      },
      { includeNames: names },
    );
  }, [disk, findings, names]);

  const save = useCallback(async (): Promise<void> => {
    const next = await window.api.aiConfigure({ baseUrl, model, apiKey });
    setStatus(next);
    setSaved(true);
    setApiKey(""); // the key is never sent back, so there is nothing to keep in the field
  }, [baseUrl, model, apiKey]);

  const send = useCallback(async (): Promise<void> => {
    setBusy(true);
    setResult(null);
    try {
      const out = await window.api.aiSummarise(payload.text);
      setResult(out);
    } catch (err) {
      setResult({ ok: false, text: "", error: String((err as Error)?.message ?? err), bytes: 0 });
    } finally {
      setBusy(false);
    }
  }, [payload.text]);

  // The licence decides, and the main process is where that is decided: the
  // interface only draws what it is told.
  if (status !== null && !status.unlocked) {
    return (
      <Sheet wide onClose={onClose}>
        <PremiumGate what={t("ai.title")} t={t} onOpen={onLicence} />
      </Sheet>
    );
  }

  return (
    <Sheet wide onClose={onClose}>
      <header>
        <h2>{t("ai.title")}</h2>
      </header>
      <div className="body">
        <p className="dim" style={{ fontSize: 12 }}>
          {t("ai.lead")}
        </p>

        {status === null &&
          (statusError !== "" ? (
            <p style={{ color: "var(--red, #b3261e)" }}>
              {t("ai.statusFailed", { why: statusError })}{" "}
              <button className="btn quiet" onClick={load}>
                {t("ai.retry")}
              </button>
            </p>
          ) : (
            <p>{t("ai.checking")}</p>
          ))}

        {status !== null && (
          <div style={{ marginTop: 8 }}>
            {!status.configured && <p style={{ fontSize: 12 }}>{t("ai.configNote")}</p>}
            {status.problem && (
              <p className="dim" style={{ fontSize: 12, color: "var(--red, #b3261e)" }}>
                {status.problem}
              </p>
            )}
            <label style={{ display: "block", marginTop: 8 }}>
              {t("ai.baseUrl")}
              <input className="input" value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setSaved(false); }} placeholder="https://…/v1" spellCheck={false} />
            </label>
            <label style={{ display: "block", marginTop: 6 }}>
              {t("ai.model")}
              <textarea
                className="input"
                rows={3}
                value={model}
                onChange={(e) => { setModel(e.target.value); setSaved(false); }}
                spellCheck={false}
              />
            </label>
            <p className="dim" style={{ fontSize: 12 }}>
              {t("ai.modelsHint")}
            </p>
            <label style={{ display: "block", marginTop: 6 }}>
              {t("ai.key")}
              <input
                className="input"
                type="password"
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setSaved(false); }}
                placeholder={status.hasKey ? t("ai.keyKept") : ""}
                spellCheck={false}
              />
            </label>
            <button className="btn primary" style={{ marginTop: 8 }} onClick={() => void save()}>
              {saved ? t("ai.saved") : t("ai.save")}
            </button>
          </div>
        )}

        {status !== null && status.configured && (
          <>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
              <input type="checkbox" checked={names} onChange={(e) => setNames(e.target.checked)} />
              {t("ai.names")}
            </label>
            <p className="dim" style={{ fontSize: 12, marginTop: 2 }}>
              {names ? t("ai.namesOn") : t("ai.namesOff")}
            </p>

            <h3 style={{ marginTop: 12 }}>{t("ai.preview")}</h3>
            <pre
              style={{
                maxHeight: 220,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                fontSize: 11,
                lineHeight: 1.45,
                padding: 8,
                border: "1px solid rgba(128,128,128,0.35)",
                borderRadius: 4,
                margin: 0,
              }}
            >
              {payload.text}
            </pre>
            <p className="dim" style={{ fontSize: 12, marginTop: 4 }}>
              {t("ai.bytes", { bytes: fmt.bytes(payload.bytes) })}
            </p>

            {result && (
              <div style={{ marginTop: 12 }}>
                {result.ok ? (
                  <>
                    <h3>{t("ai.resultTitle")}</h3>
                    <p style={{ whiteSpace: "pre-wrap" }}>{result.text}</p>
                    <p className="dim" style={{ fontSize: 12 }}>
                      {t("ai.resultNote")}
                      {result.model ? " " + t("ai.answeredBy", { model: result.model }) : ""}
                    </p>
                  </>
                ) : (
                  <p style={{ color: "var(--red, #b3261e)" }}>
                    {t("ai.failed")}: {result.error}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>
      <footer>
        {status !== null && status.configured && (
          <button className="btn primary" disabled={busy} onClick={() => void send()}>
            <Icon name="scan" />
            {busy ? t("ai.working") : result ? t("ai.again") : t("ai.send")}
          </button>
        )}
        <button className="btn" autoFocus onClick={onClose}>
          {t("ai.close")}
        </button>
      </footer>
    </Sheet>
  );
}
