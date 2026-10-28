import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { normalizePath } from "../shared/cleanup";
import { refuseReason } from "./scope";

const roots = (...r: string[]): Set<string> => new Set(r.map(normalizePath));

const ask = (path: string, set: Set<string>, reach: "scan" | "target" = "scan"): string | null =>
  refuseReason({ path, roots: set, reach });

describe("scope: what the window may reach", () => {
  it("allows the folder that was scanned", () => {
    assert.equal(ask("C:\\Users\\me\\Project", roots("C:\\Users\\me\\Project")), null);
  });

  it("allows anything inside the folder that was scanned", () => {
    const set = roots("C:\\Users\\me\\Project");
    assert.equal(ask("C:\\Users\\me\\Project\\node_modules", set), null);
    assert.equal(ask("C:\\Users\\me\\Project\\a\\b\\c.txt", set), null);
  });

  it("allows a path inside any one of several scanned folders", () => {
    const set = roots("C:\\one", "D:\\two");
    assert.equal(ask("C:\\one\\x", set), null);
    assert.equal(ask("D:\\two\\y", set), null);
  });

  it("refuses a folder that was never scanned", () => {
    assert.match(String(ask("C:\\Users\\me\\Elsewhere", roots("C:\\Users\\me\\Project"))), /not part of a scan/);
  });

  it("refuses a sibling whose name starts the same way", () => {
    // "C:\Users\me\Project2" is not inside "C:\Users\me\Project".
    assert.match(String(ask("C:\\Users\\me\\Project2\\x", roots("C:\\Users\\me\\Project"))), /not part of a scan/);
  });

  it("refuses a traversal that climbs out of the scanned folder", () => {
    const reason = ask("C:\\Users\\me\\Project\\..\\..\\Windows", roots("C:\\Users\\me\\Project"));
    assert.notEqual(reason, null);
  });

  it("refuses a wildcard outright, in either reach", () => {
    const set = roots("C:\\Users\\me\\Project");
    assert.match(String(ask("C:\\Users\\me\\Project\\*", set)), /wildcard/);
    assert.match(String(ask("C:\\Users\\me\\Project\\*", set, "target")), /wildcard/);
  });

  it("refuses an empty path rather than treating it as a location", () => {
    assert.notEqual(ask("", roots("C:\\Users\\me\\Project")), null);
  });

  it("is not fooled by case", () => {
    assert.equal(ask("c:\\users\\ME\\project\\x", roots("C:\\Users\\me\\Project")), null);
  });

  it("refuses the scanned folder as a target, but allows it as a subject", () => {
    const set = roots("C:\\Users\\me\\Project");
    assert.equal(ask("C:\\Users\\me\\Project", set, "scan"), null);
    assert.match(String(ask("C:\\Users\\me\\Project", set, "target")), /not itself a target/);
  });

  it("allows a drive root as a subject, so a whole drive can be scanned and shown", () => {
    assert.equal(ask("C:\\", roots("C:\\"), "scan"), null);
  });

  it("refuses a drive root as a target", () => {
    assert.notEqual(ask("C:\\", roots("C:\\"), "target"), null);
  });
});

describe("scope: the rule that survives a hostile renderer", () => {
  // These are refused even when the folder *was* scanned, because the reason is
  // the location itself, not the scope. That is what makes this rule worth
  // having: a renderer that can start a scan cannot make C:\Windows acceptable.
  it("refuses an operating-system folder even as the scanned root", () => {
    assert.match(String(ask("C:\\Windows", roots("C:\\Windows"))), /operating system/);
    assert.match(String(ask("C:\\Windows\\System32\\x.dll", roots("C:\\Windows"))), /operating system/);
    assert.match(String(ask("C:\\Program Files\\App\\x", roots("C:\\Program Files"))), /operating system/);
    assert.match(String(ask("C:\\ProgramData\\x", roots("C:\\ProgramData"))), /operating system/);
    assert.match(String(ask("C:\\$Recycle.Bin\\x", roots("C:\\$Recycle.Bin"))), /operating system/);
  });

  it("refuses a credential store even inside a folder that was scanned", () => {
    const set = roots("C:\\Users\\me");
    assert.match(String(ask("C:\\Users\\me\\.ssh\\id_rsa", set)), /protected location/);
    assert.match(String(ask("C:\\Users\\me\\Project\\.git\\config", set)), /protected location/);
    assert.match(String(ask("C:\\Users\\me\\Cookies", set)), /protected location/);
  });

  it("does not refuse a folder whose name merely starts like a protected one", () => {
    assert.equal(ask("C:\\ProgramData2\\x", roots("C:\\ProgramData2")), null);
    assert.equal(ask("C:\\Users\\me\\logins.json.bak", roots("C:\\Users\\me")), null);
  });
});

describe("scope: folders the person protects from cleanup", () => {
  const set = roots("C:\\Users\\me");
  const extra = ["C:\\Users\\me\\Project\\keep"];

  it("refuses a deletion inside a folder the person protects", () => {
    const reason = refuseReason({ path: "C:\\Users\\me\\Project\\keep\\a.bin", roots: set, reach: "target", extraProtected: extra });
    assert.match(String(reason), /protect/);
  });

  it("refuses the protected folder itself as a deletion target", () => {
    const reason = refuseReason({ path: "C:\\Users\\me\\Project\\keep", roots: set, reach: "target", extraProtected: extra });
    assert.match(String(reason), /protect/);
  });

  it("still allows scanning, opening and measuring a protected folder", () => {
    // The list is about deletion, not visibility: a folder you protect is still a
    // folder you can look at.
    assert.equal(refuseReason({ path: "C:\\Users\\me\\Project\\keep\\a.bin", roots: set, reach: "scan", extraProtected: extra }), null);
  });

  it("does not refuse anything outside the protected folder", () => {
    assert.equal(refuseReason({ path: "C:\\Users\\me\\Project\\other\\a.bin", roots: set, reach: "target", extraProtected: extra }), null);
  });

  it("cannot be used to allow something the policy already refuses", () => {
    const reason = refuseReason({ path: "C:\\Windows\\Temp\\x", roots: roots("C:\\Windows"), reach: "target", extraProtected: extra });
    assert.match(String(reason), /operating system/);
  });
});
