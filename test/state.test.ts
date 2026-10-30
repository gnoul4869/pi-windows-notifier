import assert from "node:assert/strict";
import { test } from "node:test";
import { NotificationState } from "../src/state.ts";
import type { NotificationJob } from "../src/types.ts";

function fixture() {
  const jobs: NotificationJob[] = [];
  const cancelled: string[] = [];
  const diagnostics: string[] = [];
  const state = new NotificationState({ enqueue: job => jobs.push(job), cancel: key => cancelled.push(key) },
    code => diagnostics.push(code));
  return { state, jobs, cancelled, diagnostics };
}
test("Permission handles only ask, dedup, forwarding, and decision cancellation, storing no sensitive fields", () => {
  const { state, jobs, cancelled } = fixture();
  state.permissionDecision({ requestId: "auto-allow" });
  assert.equal(jobs.length, 0);
  state.permissionPrompt({ requestId: "r", value: "SECRET", forwarding: { requesterAgentName: "SECRET" } });
  state.permissionPrompt({ requestId: "r" });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].valid(), true);
  assert.equal(JSON.stringify(jobs).includes("SECRET"), false);
  state.permissionDecision({ requestId: "r" });
  assert.equal(jobs[0].valid(), false);
  assert.ok(cancelled.includes("permission:r"));
});
test("Event ID length limits and a bounded cache", () => {
  const { state, jobs } = fixture();
  state.permissionPrompt({ requestId: "x".repeat(257) });
  state.permissionPrompt({ requestId: "\n" });
  assert.equal(jobs.length, 0);
  for (let i = 0; i < 257; i++) state.permissionPrompt({ requestId: String(i) });
  assert.equal(jobs[0].valid(), false);
  state.permissionPrompt({ requestId: "256" });
  assert.equal(jobs.length, 257);
});
test("RPIV and shared-UI dedup; a multi-question, multi-step UI is announced once", () => {
  const { state, jobs } = fixture();
  state.toolStart({ toolCallId: "q", toolName: "ask_user_question", args: { secret: "SECRET" } });
  state.rpivBlocked({ active: true });
  state.uiStart();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].valid(), true);
  state.uiEnd();
  state.rpivBlocked({ active: false });
  state.uiStart();
  assert.equal(jobs.length, 1);
  state.uiEnd();
  state.toolEnd({ toolCallId: "q" });
  assert.equal(jobs[0].valid(), false);
});
test("Plan mode really waits for the UI and doesn't reclassify a permission UI as a question", () => {
  const { state, jobs } = fixture();
  state.toolStart({ toolCallId: "plan", toolName: "plan_mode_question" });
  assert.equal(jobs.length, 0);
  state.permissionPrompt({ requestId: "permission" });
  state.uiStart();
  assert.equal(jobs.length, 1);
  state.uiEnd();
  state.permissionDecision({ requestId: "permission" });
  state.uiStart();
  assert.equal(jobs[1].kind, "question");
  state.uiEnd();
});
test("Manual UI, no UI, validation failure, and unrecognized concurrent UI announce nothing", () => {
  const { state, jobs, diagnostics } = fixture();
  state.uiStart();
  state.toolStart({ toolCallId: "a", toolName: "ask_user_question" });
  state.rpivBlocked({ active: true });
  state.uiStart();
  assert.equal(jobs.length, 0);
  state.uiEnd();
  state.toolEnd({ toolCallId: "a" });
  state.toolStart({ toolCallId: "invalid", toolName: "plan_mode_question" });
  state.toolEnd({ toolCallId: "invalid" });
  state.toolStart({ toolCallId: "b", toolName: "plan_mode_question" });
  state.toolStart({ toolCallId: "c", toolName: "ask_user_question" });
  state.uiStart();
  state.rpivBlocked({ active: true });
  assert.equal(jobs.length, 0);
  assert.ok(diagnostics.includes("UI_AMBIGUOUS"));
});
test("Retry/continuation notifies only when settled, with the final result taking priority", () => {
  const { state, jobs } = fixture();
  state.agentStart();
  state.messageEnd({ message: { role: "assistant", stopReason: "error", errorMessage: "SECRET" } });
  state.boundary({ outcome: "error" });
  state.agentStart();
  assert.equal(jobs.length, 0);
  state.messageEnd({ message: { role: "assistant", stopReason: "stop" } });
  state.boundary({ outcome: "completed" });
  state.settled({ aborted: false });
  state.settled({ aborted: false });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "completed");
  state.agentStart();
  assert.equal(jobs[0].valid(), false);
  state.boundary({ outcome: "error" });
  state.settled({ aborted: false });
  assert.equal(jobs[1].kind, "failed");
});
test("Esc outranks success, an empty run reports no success, and a tool error isn't a model failure", () => {
  const { state, jobs } = fixture();
  state.agentStart();
  state.settled({ aborted: false });
  assert.equal(jobs.length, 0);
  state.agentStart();
  state.settled({ aborted: true });
  assert.equal(jobs.length, 0);
  state.agentStart();
  state.messageEnd({ message: { role: "toolResult", isError: true } });
  state.messageEnd({ message: { role: "assistant", stopReason: "stop" } });
  state.settled({ aborted: true });
  assert.equal(jobs[0].kind, "aborted");
  state.agentStart();
  state.messageEnd({ message: { role: "toolResult", isError: true } });
  state.messageEnd({ message: { role: "assistant", stopReason: "stop" } });
  state.settled({ aborted: false });
  assert.equal(jobs[1].kind, "completed");
});
test("Repeated or concurrent UI start signals cancel an unsent question without guessing ownership", () => {
  const { state, jobs, cancelled } = fixture();
  state.toolStart({ toolCallId: "q", toolName: "plan_mode_question" });
  state.uiStart();
  assert.equal(jobs[0].valid(), true);
  state.uiStart();
  assert.equal(jobs[0].valid(), false);
  assert.ok(cancelled.includes("question:q"));
});
test("reset invalidates old events and can be called repeatedly", () => {
  const { state, jobs } = fixture();
  state.permissionPrompt({ requestId: "old" });
  state.toolStart({ toolCallId: "q", toolName: "ask_user_question" });
  state.reset();
  state.reset();
  assert.equal(jobs[0].valid(), false);
  state.permissionPrompt({ requestId: "old" });
  assert.equal(jobs.length, 2);
});
test("settle reports diagnostic codes for a missing run state and a missing assistant reply, never failing silently", () => {
  const { state, jobs, diagnostics } = fixture();
  state.settled({ aborted: false });
  assert.equal(jobs.length, 0);
  assert.ok(diagnostics.includes("SETTLED_WITHOUT_RUN"));

  state.agentStart();
  state.settled({ aborted: false });
  assert.equal(jobs.length, 0);
  assert.ok(diagnostics.includes("SETTLED_NO_OUTCOME"));

  state.agentStart();
  state.messageEnd({ message: { role: "assistant", stopReason: "stop" } });
  state.settled({ aborted: false });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "completed");

  state.settled(undefined);
  assert.ok(diagnostics.includes("EVENT_INVALID"));
});
