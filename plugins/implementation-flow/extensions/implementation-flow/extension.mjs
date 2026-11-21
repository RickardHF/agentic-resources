import { createCanvas, defineWorkflow, joinSession } from "@github/copilot-sdk/extension";
import { randomUUID } from "node:crypto";
import { meta, run } from "./workflow.mjs";
import { createStore, resolveArtifactRoot } from "./storage.mjs";
import { logError, startObserver } from "./observer.mjs";
import { createDashboardCanvas } from "./dashboard.mjs";

const store = createStore(await resolveArtifactRoot());
let session;
let observer;
const dashboard = createDashboardCanvas(createCanvas, store, {
  session: () => session,
  health: () => observer?.health() ?? { errors: [] },
  reportError: (error) => { void logError(session, `Implementation flow dashboard failed: ${error.message}`); },
});
const resumeRun = (runId) => {
  try {
    void session.workflow.resume(runId, { notifyOnComplete: true }).catch((error) =>
      logError(session, `Implementation flow could not resume ${runId}: ${error.message}`));
  } catch (error) {
    void logError(session, `Implementation flow could not resume ${runId}: ${error.message}`);
  }
};
const ownedRun = async (runId, invocation) => {
  if (invocation.sessionId !== session.sessionId) throw new Error("This session cannot control another session's workflow run.");
  const run = await store.getRun(runId);
  if (run.observation?.ownerSessionId !== session.sessionId) throw new Error("Workflow run is not owned by this session.");
  return run;
};
const tools = [
  {
    name: "implementation_flow_pending",
    description: "List pending implementation-flow decisions owned by this session.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, invocation) => {
      if (invocation.sessionId !== session.sessionId) throw new Error("This session cannot inspect another session's workflow decisions.");
      const runs = await store.listRuns();
      return JSON.stringify(runs.filter((run) => run.observation?.ownerSessionId === session.sessionId && run.pendingDecision)
        .map(({ runId, title, pendingDecision }) => ({ runId, title, pendingDecision })));
    },
  },
  {
    name: "implementation_flow_respond",
    description: "Submit an offered action for a pending implementation-flow decision.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string" }, action: { type: "string" }, feedback: { type: "string" },
        plan: { type: "object" },
      },
      required: ["runId", "action"], additionalProperties: false,
    },
    handler: async (args, invocation) => {
      const run = await ownedRun(args.runId, invocation);
      const pending = run.pendingDecision;
      if (!pending || !pending.options.some((option) => option.action === args.action)) throw new Error("Action is not offered by the pending decision.");
      const selected = pending.options.find((option) => option.action === args.action);
      if (selected.requiresFeedback && !args.feedback?.trim()) throw new Error("This action requires nonempty feedback.");
      await store.writeInbox(args.runId, {
        id: randomUUID(), key: pending.key, action: args.action,
        feedback: args.feedback ?? "", ...(args.plan ? { plan: args.plan } : {}), source: "chat",
      });
      resumeRun(args.runId);
      return `Response queued for ${args.runId}.`;
    },
  },
  {
    name: "implementation_flow_feedback",
    description: "Queue chat feedback for the next implementation-flow planning or implementation checkpoint.",
    parameters: {
      type: "object", properties: { runId: { type: "string" }, feedback: { type: "string" } },
      required: ["runId", "feedback"], additionalProperties: false,
    },
    handler: async (args, invocation) => {
      const run = await ownedRun(args.runId, invocation);
      await store.queueFeedback(args.runId, args.feedback, "chat");
      if (run.observation.status === "paused" && !run.pendingDecision) resumeRun(args.runId);
      return `Feedback queued for ${args.runId}.`;
    },
  },
  {
    name: "implementation_flow_attach_evidence",
    description: "Attach later verification evidence to an owned implementation-flow run.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string" }, id: { type: "string" }, criterionId: { type: "string" },
        description: { type: "string" }, command: { type: "string" },
        outcome: { type: "string", enum: ["passed", "failed"] }, evidence: { type: "string" },
      },
      required: ["runId", "id", "description", "outcome", "evidence"], additionalProperties: false,
    },
    handler: async (args, invocation) => {
      const run = await ownedRun(args.runId, invocation);
      await store.appendVerification(args.runId, { ...args, source: "chat" });
      if (run.pendingDecision?.options.some((option) => option.action === "evidence")) {
        await store.writeInbox(args.runId, {
          id: randomUUID(), key: run.pendingDecision.key, action: "evidence",
          feedback: "", source: "chat",
        });
        resumeRun(args.runId);
      }
      return `Verification evidence attached to ${args.runId}.`;
    },
  },
];
let cleanupTask;
const cleanup = () => cleanupTask ??= Promise.all([observer?.close(), dashboard.close()]).then(() => {});
session = await joinSession({
  workflows: [defineWorkflow({ meta, run })],
  tools,
  canvases: [dashboard.canvas],
  hooks: { onSessionEnd: cleanup },
});
observer = startObserver(session, store);
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    void cleanup().then(() => process.exit(0), async (error) => {
      await logError(session, `Implementation flow dashboard cleanup failed: ${error.message}`);
      process.exit(1);
    });
  });
}
