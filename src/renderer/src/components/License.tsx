// The licence surface: what plan this computer is on, a place to paste a key,
// and the point where a premium view says so instead of quietly disappearing.
//
// Two rules this file exists to keep visible:
//   - expiry is a feature switch, never a data lock. The copy says so out loud.
//   - a gated view explains itself rather than vanishing, so nobody is left
//     wondering whether the application is broken.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { FREE_FEATURES, PRO_FEATURES } from "../../../shared/entitlements";
import type { LicenseState } from "../../../shared/entitlements";
import type { T } from "../lib/i18n";
import { Icon } from "./Icon";

function Sheet({ children, onClose, wide }: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "wide" : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}

// The dictionary is a closed union of literal keys, so a key built from a
// feature id needs exactly one cast. Nothing is unchecked by it: every id in
// shared/entitlements.ts has a matching "feature.<id>" entry in both
// dictionaries, and the dictionary type is what makes a missing one a build
// error rather than a raw key on screen.
function featureLabel(t: T, id: string): string {
  return t(`feature.${id}` as Parameters<T>[0]);
}

function FeatureList({ keys, t }: { keys: ReadonlySet<string>; t: T }) {
  return (
    <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
      {[...keys].map((k) => (
        <li key={k}>{featureLabel(t, k)}</li>
      ))}
    </ul>
  );
}

function statusLine(state: LicenseState, t: T): string {
  switch (state.status) {
    case "none":
      return t("lic.status.none");
    case "valid":
      return t("lic.status.valid", { days: state.daysLeft ?? 0 });
    case "grace":
      return t("lic.status.grace");
    case "expired":
      return t("lic.status.expired");
    case "invalid":
      return t("lic.status.invalid");
  }
}

export function LicenseDialog(p: {
  state: LicenseState;
  t: T;
  onClose: () => void;
  onChanged: (state: LicenseState) => void;
}) {
  const { state, t, onChanged } = p;
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  const activate = async (): Promise<void> => {
    setBusy(true);
    try {
      const next = await window.api.activateLicense(key);
      onChanged(next);
      setSaid(next.pro ? t("lic.accepted") : (next.problem ?? t("lic.status.invalid")));
      if (next.pro) setKey("");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      onChanged(await window.api.clearLicense());
      setSaid(t("lic.removed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet wide onClose={p.onClose}>
      <header>
        <h2>{t("lic.title")}</h2>
      </header>
      <div className="body">
        <p className="what">
          {state.pro ? t("lic.plan.pro") : t("lic.plan.free")} · {statusLine(state, t)}
        </p>
        {state.payload ? <p className="dim">{t("lic.licensee", { sub: state.payload.sub })}</p> : null}
        {state.problem && !said ? <p>{state.problem}</p> : null}
        {said ? <p className="what">{said}</p> : null}

        <label style={{ display: "block", marginTop: 12 }}>
          {t("lic.key")}
          <textarea
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={t("lic.keyHint")}
            spellCheck={false}
            rows={4}
            style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
          />
        </label>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button className="btn" disabled={busy || key.trim() === ""} onClick={() => void activate()}>
            {t("lic.activate")}
          </button>
          <button className="btn quiet" disabled={busy || state.status === "none"} onClick={() => void remove()}>
            {t("lic.remove")}
          </button>
        </div>

        <h3 style={{ marginTop: 12 }}>{t("lic.free")}</h3>
        <FeatureList keys={FREE_FEATURES} t={t} />
        <h3 style={{ marginTop: 12 }}>{t("lic.proList")}</h3>
        <FeatureList keys={PRO_FEATURES} t={t} />

        <p className="dim" style={{ fontSize: 12, marginTop: 12 }}>
          {t("lic.note")}
        </p>
      </div>
      <footer>
        <button className="btn" autoFocus onClick={p.onClose}>
          {t("lic.close")}
        </button>
      </footer>
    </Sheet>
  );
}

// Shown in place of a premium view. It names the view and the way out rather
// than pretending the feature does not exist.
export function PremiumGate(p: { what: string; t: T; onOpen: () => void }): ReactNode {
  const { t } = p;
  return (
    <div className="pane">
      <div className="pane-empty" style={{ maxWidth: "58ch", margin: "0 auto", textAlign: "left" }}>
        <p className="what" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name="warn" size={16} />
          {t("lic.gated.title")}
        </p>
        <p>{t("lic.gated.body", { what: p.what })}</p>
        <button className="btn" onClick={p.onOpen}>
          {t("lic.gated.open")}
        </button>
      </div>
    </div>
  );
}


