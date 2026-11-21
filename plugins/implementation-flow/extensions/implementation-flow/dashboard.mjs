import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ReadError } from "./storage.mjs";

const assets = new Map([
  ["", ["dashboard.html", "text/html; charset=utf-8"]],
  ["dashboard.js", ["dashboard.js", "text/javascript; charset=utf-8"]],
  ["dashboard.css", ["dashboard.css", "text/css; charset=utf-8"]],
  ["renderer.mjs", ["renderer.mjs", "text/javascript; charset=utf-8"]],
  ["diff.mjs", ["diff.mjs", "text/javascript; charset=utf-8"]],
]);
const policy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

const MAX_BODY_BYTES = 1_048_576;
const runInput = {
  type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false,
};

function createController(store, options = {}) {
  const getSession = () => typeof options.session === "function" ? options.session() : options.session;
  const ownerRun = async (runId) => {
    const session = getSession();
    if (!session) throw new ReadError("Workflow controls are not available.", 503);
    const run = await store.getRun(runId);
    if (run.observation?.ownerSessionId !== session.sessionId) throw new ReadError("Workflow run is not owned by this session.", 403);
    return { run, session };
  };
  const resume = (session, runId) => {
    void session.workflow.resume(runId, { notifyOnComplete: true }).catch(options.reportError ?? (() => {}));
    return { queued: true };
  };
  return {
    async respond({ runId, action, feedback = "", plan }) {
      const { run, session } = await ownerRun(runId);
      const pending = run.pendingDecision;
      const option = pending?.options.find((entry) => entry.action === action);
      if (!option) throw new ReadError("Action is not offered by the pending decision.", 409);
      if (option.requiresFeedback && !feedback.trim()) throw new ReadError("This action requires nonempty feedback.");
      await store.writeInbox(runId, {
        id: randomBytes(16).toString("hex"), key: pending.key, action, feedback,
        ...(plan ? { plan } : {}), source: "dashboard",
      });
      return resume(session, runId);
    },
    async feedback({ runId, feedback }) {
      const { run, session } = await ownerRun(runId);
      await store.queueFeedback(runId, feedback, "dashboard");
      if (run.observation.status === "paused" && !run.pendingDecision) return resume(session, runId);
      return { queued: true, paused: run.observation.status === "paused" };
    },
    async evidence({ runId, ...entry }) {
      const { run, session } = await ownerRun(runId);
      await store.appendVerification(runId, { ...entry, source: "dashboard" });
      if (run.pendingDecision?.options.some((option) => option.action === "evidence")) {
        await store.writeInbox(runId, {
          id: randomBytes(16).toString("hex"), key: run.pendingDecision.key, action: "evidence", feedback: "", source: "dashboard",
        });
        return resume(session, runId);
      }
      return { queued: true };
    },
    async start({ args, confirm }) {
      if (confirm !== true) throw new ReadError("Confirm before starting a workflow.");
      const session = getSession();
      if (!session) throw new ReadError("Workflow controls are not available.", 503);
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new ReadError("Workflow arguments must be an object.");
      void session.workflow.run("implementation-flow", args).catch(options.reportError ?? (() => {}));
      return { queued: true };
    },
    async control(action, { runId }) {
      const { session } = await ownerRun(runId);
      if (action === "pause") void session.workflow.pause(runId).catch(options.reportError ?? (() => {}));
      else if (action === "resume") return resume(session, runId);
      else if (action === "cancel") void session.workflow.cancel(runId).catch(options.reportError ?? (() => {}));
      else throw new ReadError("Unknown workflow control.");
      return { queued: true };
    },
  };
}

async function readJsonBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new ReadError("Request body exceeds the size limit.", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ReadError("Request body must be valid JSON."); }
}

export async function startDashboardServer(store, { health = () => ({ errors: [] }), reportError = () => {}, ...options } = {}) {
  const prefix = `/${randomBytes(24).toString("hex")}/`;
  const controller = createController(store, { ...options, reportError });
  let origin;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", policy);
    const send = (status, data, type = "application/json; charset=utf-8") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
    };
    try {
      if (req.headers.host !== new URL(origin).host ||
          req.headers.origin && req.headers.origin !== origin) throw new ReadError("Request origin is not allowed.", 403);
      const url = new URL(req.url, origin);
      if (!url.pathname.startsWith(prefix)) throw new ReadError("Dashboard capability not found.", 404);
      const route = url.pathname.slice(prefix.length);
      if (req.method === "POST") {
        if (req.headers["sec-fetch-site"] === "cross-site") throw new ReadError("Cross-site data requests are not allowed.", 403);
        if (!new Set(["api/respond", "api/feedback", "api/evidence", "api/start", "api/pause", "api/resume", "api/cancel"]).has(route)) {
          if (route.startsWith("api/") && ["api/runs", "api/run", "api/artifact"].includes(route)) {
            res.setHeader("Allow", "GET");
            throw new ReadError("Endpoint is read-only.", 405);
          }
          throw new ReadError("Endpoint not found.", 404);
        }
        if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json" ||
            req.headers["x-implementation-flow"] !== "1") throw new ReadError("Mutation requests require JSON and the dashboard request header.", 415);
        const body = await readJsonBody(req);
        const result = route === "api/respond" ? await controller.respond(body)
          : route === "api/feedback" ? await controller.feedback(body)
          : route === "api/evidence" ? await controller.evidence(body)
          : route === "api/start" ? await controller.start(body)
          : ["api/pause", "api/resume", "api/cancel"].includes(route) ? await controller.control(route.slice(4), body)
          : (() => { throw new ReadError("Endpoint not found.", 404); })();
        send(202, result);
        return;
      }
      if (req.method !== "GET") { res.setHeader("Allow", "GET, POST"); throw new ReadError("Method not allowed.", 405); }
      if (assets.has(route)) {
        const [name, type] = assets.get(route);
        send(200, await readFile(new URL(name, import.meta.url)), type);
      } else {
        if (req.headers["sec-fetch-site"] === "cross-site") throw new ReadError("Cross-site data requests are not allowed.", 403);
        const runId = url.searchParams.get("runId");
        if (route === "api/runs") send(200, { runs: await store.listRuns(), observer: health() });
        else if (route === "api/run") send(200, await store.getRun(runId));
        else if (route === "api/artifact") send(200, await store.readArtifact(runId, url.searchParams.get("name")));
        else throw new ReadError("Endpoint not found.", 404);
      }
    } catch (error) {
      const status = error instanceof ReadError ? error.status : error.code === "ENOENT" ? 404 : ["ELOOP", "EACCES"].includes(error.code) ? 403 : 500;
      if (status === 500) reportError(error);
      send(status, { error: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  server.on("error", reportError);
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: origin + prefix,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

export function createDashboardCanvas(createCanvas, store, options) {
  const instances = new Map();
  const controller = createController(store, options);
  const close = async (instanceId) => {
    const entry = instances.get(instanceId);
    instances.delete(instanceId);
    if (entry) await (await entry).close();
  };
  return {
    canvas: createCanvas({
      id: "implementation-flow-runs",
      displayName: "Implementation flow runs",
      description: "Read-only implementation-flow progress and local artifact inspection across sessions for this checkout.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      actions: [
        { name: "list_runs", description: "Read the recorded implementation-flow runs for this checkout.", handler: () => store.listRuns() },
        { name: "respond", description: "Respond to a pending workflow decision.", inputSchema: { type: "object", properties: { runId: { type: "string" }, action: { type: "string" }, feedback: { type: "string" }, plan: { type: "object" } }, required: ["runId", "action"], additionalProperties: false }, handler: ({ input }) => controller.respond(input) },
        { name: "add_feedback", description: "Queue feedback for the next planning or implementation checkpoint.", inputSchema: { type: "object", properties: { runId: { type: "string" }, feedback: { type: "string" } }, required: ["runId", "feedback"], additionalProperties: false }, handler: ({ input }) => controller.feedback(input) },
        { name: "attach_evidence", description: "Attach verification evidence to a workflow run.", inputSchema: { type: "object", properties: { runId: { type: "string" }, id: { type: "string" }, criterionId: { type: "string" }, description: { type: "string" }, command: { type: "string" }, outcome: { type: "string", enum: ["passed", "failed"] }, evidence: { type: "string" } }, required: ["runId", "id", "description", "outcome", "evidence"], additionalProperties: false }, handler: ({ input }) => controller.evidence(input) },
        { name: "start", description: "Start a workflow after explicit confirmation.", inputSchema: { type: "object", properties: { args: { type: "object" }, confirm: { type: "boolean" } }, required: ["args", "confirm"], additionalProperties: false }, handler: ({ input }) => controller.start(input) },
        ...["pause", "resume", "cancel"].map((action) => ({
          name: action, description: `${action[0].toUpperCase()}${action.slice(1)} an owned workflow run.`,
          inputSchema: runInput, handler: ({ input }) => controller.control(action, input),
        })),
      ],
      open: async ({ instanceId }) => {
        if (!instances.has(instanceId)) {
          const entry = startDashboardServer(store, options).catch((error) => {
            instances.delete(instanceId);
            throw error;
          });
          instances.set(instanceId, entry);
        }
        return { title: "Implementation flow runs", url: (await instances.get(instanceId)).url };
      },
      onClose: ({ instanceId }) => close(instanceId),
    }),
    close: () => Promise.all([...instances.keys()].map(close)),
  };
}
