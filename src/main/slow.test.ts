// The one pure piece of the machine readings: turning Windows' own error text into a
// sentence a person can act on.
//
// The case that prompted it: reading the start-up log unelevated fails with "Attempted
// to perform an unauthorized operation.", which reads as though the application had
// tried something it should not have. It means the log is kept for administrators.
import { test } from "node:test";
import assert from "node:assert/strict";
import { explainReason } from "./slow";

test("an access refusal says what the log needs, not what .NET called it", () => {
  const text = explainReason("the start-up log", "Attempted to perform an unauthorized operation.");
  assert.match(text, /administrators/, "it names who the log belongs to");
  assert.match(text, /without administrator rights/, "and says no elevation is asked for");
  assert.doesNotMatch(text, /unauthorized/i, "the alarming word is gone: nothing improper was tried");
});

test("the same refusal worded another way is recognised too", () => {
  assert.match(explainReason("the disk counters", "Access is denied."), /administrators/);
  assert.match(explainReason("the memory counters", "The client does not have permission."), /administrators/);
});

test("any other reason is passed through exactly as Windows gave it", () => {
  const other = "Windows kept no boot measurement";
  assert.equal(explainReason("the start-up log", other), other);
});
