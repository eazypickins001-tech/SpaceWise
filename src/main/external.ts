// Which addresses the interface may ask the operating system to open.
//
// This lives on its own rather than inside index.ts so the rule can be tested
// directly. It is the one place a renderer-supplied string reaches the
// system's URL handler, so what it lets through is worth pinning:
//
//   - https, for the Help menu's website and the About box's links;
//   - a mailto carrying an address, for Help -> Contact support;
//   - a Windows settings page, by name, so a diagnosis can hand the person to the
//     screen that owns the fix instead of describing it.
//
// Nothing else. A file:// path, a plain http address or any custom scheme is not
// something this application ever needs to launch on the interface's behalf, and
// handing one to the shell is how a click becomes an unexpected program.
import { WINDOWS_PAGES } from "../shared/slow";

const HTTPS = /^https:\/\/\S+$/i;
const MAILTO = /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const SETTINGS = /^ms-settings:([a-z]+)$/i;

// The address to open, or null when it is not one this application will open.
export function openableUrl(input: unknown): string | null {
  const url = String(input ?? "").trim();
  if (HTTPS.test(url) || MAILTO.test(url)) return url;

  // Matched against the list rather than accepted as a scheme: a bare page name is
  // still a string the renderer chose, and this is the boundary that holds.
  const settings = SETTINGS.exec(url);
  if (settings && (WINDOWS_PAGES as readonly string[]).includes(settings[1].toLowerCase())) return url;

  return null;
}
