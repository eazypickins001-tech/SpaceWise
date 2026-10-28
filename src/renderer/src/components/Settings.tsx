// The one place preferences live.
//
// They used to be split: theme, appearance, folder depth and language were four
// submenus under View, and a phone had a settings sheet of its own. "Where do I
// change the theme?" therefore had a different answer depending on which window
// you were in, and on the desktop the answer was a menu you had to be told about.
import type { T } from "../lib/i18n";
import type { Choice } from "./Mobile";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

function Row<V extends string | number>(p: {
  label: string;
  value: V;
  choices: Choice<V>[];
  onPick: (v: V) => void;
}) {
  return (
    <div className="set-row">
      <strong className="set-what">{p.label}</strong>
      <div className="set-choices" role="group" aria-label={p.label}>
        {p.choices.map((c) => (
          <button
            key={String(c.value)}
            className={"btn" + (c.value === p.value ? " on" : "")}
            aria-pressed={c.value === p.value}
            onClick={() => p.onPick(c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface DesktopSettingsProps<F extends string, M extends string, L extends string> {
  t: T;
  family: F;
  families: Choice<F>[];
  onFamily: (v: F) => void;
  mode: M;
  modes: Choice<M>[];
  onMode: (v: M) => void;
  lang: L;
  langs: Choice<L>[];
  onLang: (v: L) => void;
  levels: number;
  levelChoices: Choice<number>[];
  onLevels: (v: number) => void;
  // Folders cleanup must never touch. The list lives in the main process; this
  // only draws it and asks for changes.
  protectedFolders: string[];
  onAddProtected: () => void;
  onRemoveProtected: (path: string) => void;
  onClose: () => void;
}

// Named for the desktop because Mobile.tsx already exports a SettingsSheet for
// the phone layout; both exist and they are not the same component.
export function DesktopSettings<F extends string, M extends string, L extends string>(p: DesktopSettingsProps<F, M, L>) {
  const { t } = p;
  return (
    <Sheet wide onClose={p.onClose}>
      <header>
        <h2>{t("settings.title")}</h2>
      </header>
      <div className="body">
        <div className="set-list">
          <Row label={t("menu.theme")} value={p.family} choices={p.families} onPick={p.onFamily} />
          <Row label={t("menu.mode")} value={p.mode} choices={p.modes} onPick={p.onMode} />
          <Row label={t("menu.language")} value={p.lang} choices={p.langs} onPick={p.onLang} />
          <Row label={t("menu.levels")} value={p.levels} choices={p.levelChoices} onPick={p.onLevels} />
        </div>

        <div className="set-section">
          <div className="set-head">
            <strong>{t("settings.protection")}</strong>
            <span className="dim">{t("settings.protectionNote")}</span>
          </div>
          {p.protectedFolders.length === 0 ? (
            <p className="dim">{t("settings.protectionNone")}</p>
          ) : (
            <ul className="set-paths">
              {p.protectedFolders.map((path) => (
                <li key={path}>
                  <span className="set-path" title={path}>
                    {path}
                  </span>
                  <button
                    className="btn quiet icon"
                    aria-label={t("settings.protectionRemove")}
                    title={t("settings.protectionRemove")}
                    onClick={() => p.onRemoveProtected(path)}
                  >
                    <Icon name="close" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button className="btn" onClick={p.onAddProtected}>
            <Icon name="folder" />
            {t("settings.protectionAdd")}
          </button>
        </div>
      </div>
      <footer>
        <button className="btn" autoFocus onClick={p.onClose}>
          {t("issues.close")}
        </button>
      </footer>
    </Sheet>
  );
}
