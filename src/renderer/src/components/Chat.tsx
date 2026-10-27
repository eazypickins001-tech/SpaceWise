// Asking about one folder.
//
// The facts drawn on this sheet are the application's own, and they answer most
// of what is worth asking: why this was flagged, what the rules say happens if it
// goes, and what this kind of folder is and how it comes back. The model is there
// for the follow-up questions, and it is sent those same facts. It is never asked
// to decide whether to delete anything, and the standing instructions say so --
// there is a test for every sentence of them.
import { useCallback, useEffect, useMemo, useState } from "react";
import { buildChatMessage, relativeLabel } from "../../../shared/ai-summary";
import type { ChatTurn } from "../../../shared/ai-summary";
import type { Finding } from "../../../shared/storage-intelligence";
import type { AiStatusState, AiSummaryResult } from "../../../shared/types";
import type { Disk } from "../lib/disk";
import type { Fmt, T } from "../lib/i18n";
import { PremiumGate } from "./License";
import { Sheet } from "./Sheet";
import { Icon } from "./Icon";

interface Props {
  disk: Disk;
  finding: Finding;
  category: { label: string; whatItContains: string; whyItGrows: string; regeneration: string } | null;
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

const line = (label: string, value: string, t: T): React.JSX.Element => (
  <p style={{ margin: "6px 0", fontSize: 13 }}>
    <strong>{label}</strong>
    <br />
    {value}
  </p>
);

export function ChatSheet({ disk, finding, category, t, fmt, onClose, onLicence }: Props): React.JSX.Element {
  const [status, setStatus] = useState<AiStatusState | null>(null);
  // Off unless asked for, the same as everywhere else this feature appears.
  const [names, setNames] = useState(false);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [showSent, setShowSent] = useState(false);

  // Why the status could not be read, kept so the sheet can say so rather than
  // silently behaving as if nothing is set up.
  const [statusError, setStatusError] = useState("");

  const load = useCallback((): void => {
    setStatusError("");
    void window.api
      .aiStatus()
      .then(setStatus)
      .catch((err) => setStatusError(String((err as Error)?.message ?? err)));
  }, []);

  useEffect(() => load(), [load]);

  const label = relativeLabel(disk.t.root, finding.path);

  const payload = useMemo(
    () =>
      buildChatMessage(
        {
          rootName: rootNameOf(disk.t.root),
          item: {
            label,
            bytes: finding.bytes,
            files: finding.files,
            risk: String(finding.risk),
            reason: finding.reason,
            consequence: finding.consequence,
          },
          category,
          question,
          history: turns,
          recoverable: true,
        },
        { includeNames: names },
      ),
    [disk.t.root, label, finding, category, question, turns, names],
  );

  const ask = useCallback(async (): Promise<void> => {
    if (question.trim() === "") return;
    setBusy(true);
    setProblem("");
    try {
      const out: AiSummaryResult = await window.api.aiAsk(payload.text);
      if (out.ok) {
        setTurns((was) => [...was, { question, answer: out.text }]);
        setQuestion("");
      } else {
        setProblem(out.error);
      }
    } catch (err) {
      setProblem(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }, [payload.text, question]);

  if (status !== null && !status.unlocked) {
    return (
      <Sheet wide onClose={onClose}>
        <PremiumGate what={t("ai.askTitle")} t={t} onOpen={onLicence} />
      </Sheet>
    );
  }

  return (
    <Sheet wide onClose={onClose}>
      <header>
        <h2>{t("ai.askTitle")}</h2>
      </header>
      <div className="body">
        <p className="dim" style={{ fontSize: 12 }}>
          {t("ai.askLead")}
        </p>

        {/* The application's own answer, which needs no model and no permission. */}
        {line(t("ai.askWhat"), (names ? label : t("ai.askUnnamed")) + " — " + fmt.bytes(finding.bytes), t)}
        {line(t("ai.askWhy"), finding.reason, t)}
        {line(t("ai.askIfGone"), finding.consequence, t)}
        {category && line(t("ai.askWhatKind"), category.label + ": " + category.whatItContains, t)}
        {category && line(t("ai.askComesBack"), category.regeneration, t)}

        <hr style={{ opacity: 0.2, margin: "12px 0" }} />

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={names} onChange={(e) => setNames(e.target.checked)} />
          {t("ai.names")}
        </label>

        {status !== null && !status.configured && (
          <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>
            {t("ai.askNotSetUp")}
          </p>
        )}

        {statusError !== "" && (
          <p style={{ color: "var(--red, #b3261e)", fontSize: 12, marginTop: 8 }}>
            {t("ai.statusFailed", { why: statusError })}{" "}
            <button className="btn quiet" onClick={load}>
              {t("ai.retry")}
            </button>
          </p>
        )}

        {turns.map((turn, i) => (
          <div key={i} style={{ marginTop: 10 }}>
            <p style={{ margin: 0, fontSize: 13 }}>
              <strong>{turn.question}</strong>
            </p>
            <p style={{ margin: "2px 0 0", fontSize: 13, whiteSpace: "pre-wrap" }}>{turn.answer}</p>
          </div>
        ))}

        {problem !== "" && (
          <p style={{ color: "var(--red, #b3261e)", fontSize: 13 }}>{t("ai.failed")}: {problem}</p>
        )}

        <label style={{ display: "block", marginTop: 10 }}>
          <textarea
            className="input"
            rows={2}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={t("ai.askPlaceholder")}
            spellCheck={false}
          />
        </label>

        <p className="dim" style={{ fontSize: 12 }}>
          {t("ai.askNote")}
        </p>

        <details style={{ marginTop: 6 }} open={showSent} onToggle={(e) => setShowSent((e.target as HTMLDetailsElement).open)}>
          <summary style={{ fontSize: 12, cursor: "pointer" }}>{t("ai.preview")}</summary>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, opacity: 0.8 }}>{payload.text}</pre>
        </details>
      </div>
      <footer>
        <button className="btn primary" disabled={busy || question.trim() === ""} onClick={() => void ask()}>
          <Icon name="scan" />
          {busy ? t("ai.working") : t("ai.askSend")}
        </button>
        <button className="btn" autoFocus onClick={onClose}>
          {t("ai.close")}
        </button>
      </footer>
    </Sheet>
  );
}
