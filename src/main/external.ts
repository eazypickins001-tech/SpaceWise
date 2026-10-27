// Which addresses the interface may ask the operating system to open.
//
// This lives on its own rather than inside index.ts so the rule can be tested
// directly. It is the one place a renderer-supplied string reaches the
// system's URL handler, so what it lets through is worth pinning:
//
//   - https, for the Help menu's website and the About box's links;
//   - a mailto carrying an address, for Help -> Contact support.
//
// Nothing else. A file:// path, a plain http address or any custom scheme is not
// something this application ever needs to launch on the interface's behalf, and
// handing one to the shell is how a click becomes an unexpected program.
const HTTPS = /^https:\/\/\S+$/i;
const MAILTO = /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i;

// The address to open, or null when it is not one this application will open.
export function openableUrl(input: unknown): string | null {
  const url = String(input ?? "").trim();
  if (HTTPS.test(url) || MAILTO.test(url)) return url;
  return null;
}
