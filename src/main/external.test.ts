// What the interface may ask the operating system to open.
//
// The Help menu hands this module a website and a contact address; both come
// from the interface, so this is the boundary that has to hold. Before the
// contact entry existed the rule was a bare `https://` test inline in index.ts;
// widening it is exactly the kind of change that should be pinned rather than
// eyeballed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openableUrl } from "./external";

test("opens an https address, which is what the Help menu is built on", () => {
  assert.equal(openableUrl("https://github.com/eazypickins001-tech/SpaceWise"), "https://github.com/eazypickins001-tech/SpaceWise");
  assert.equal(openableUrl("HTTPS://example.com"), "HTTPS://example.com", "the scheme is case-insensitive");
});

test("opens a mailto that carries an address, for the contact entry", () => {
  assert.equal(openableUrl("mailto:denorgerald@gmail.com"), "mailto:denorgerald@gmail.com");
  assert.equal(openableUrl("mailto:someone@example.co.uk"), "mailto:someone@example.co.uk");
});

test("refuses a mailto with no address in it", () => {
  for (const bad of ["mailto:", "mailto:not-an-address", "mailto:@example.com", "mailto:a b@example.com"]) {
    assert.equal(openableUrl(bad), null, bad);
  }
});

test("refuses a plain http address", () => {
  assert.equal(openableUrl("http://example.com"), null, "only https is opened");
});

test("refuses a file path or any other scheme", () => {
  for (const bad of ["file:///C:/Windows/System32/cmd.exe", "javascript:alert(1)", "vbscript:msgbox", "ms-settings:", "\\\\server\\share"]) {
    assert.equal(openableUrl(bad), null, bad);
  }
});

test("opens a Windows settings page that is on the closed list", () => {
  assert.equal(openableUrl("ms-settings:startupapps"), "ms-settings:startupapps");
  assert.equal(openableUrl("MS-SETTINGS:storagesense"), "MS-SETTINGS:storagesense", "the scheme is case-insensitive");
});

test("refuses a settings page that is not on the list", () => {
  // Not "any ms-settings: URI": an arbitrary page name is still a string the
  // interface chose, so the list is matched exactly.
  for (const bad of ["ms-settings:privacy", "ms-settings:startupapps;calc", "ms-settings:a b", "ms-settings:..\\x"]) {
    assert.equal(openableUrl(bad), null, bad);
  }
});

test("refuses nothing at all, rather than treating it as a location", () => {
  assert.equal(openableUrl(""), null);
  assert.equal(openableUrl("   "), null);
  assert.equal(openableUrl(undefined), null);
  assert.equal(openableUrl(null), null);
});

test("trims the address rather than refusing it for a stray space", () => {
  assert.equal(openableUrl("  https://example.com  "), "https://example.com");
});
