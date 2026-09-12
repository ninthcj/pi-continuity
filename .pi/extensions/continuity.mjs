// Pi 0.85.1 extension seam. Put this file in .pi/extensions and run with
// PI_CONTINUITY_MODE=record|active pi (default is off).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ContinuityStore } from "../../src/core.mjs";

export default function continuity(pi) {
  // The SDK host owns request injection and evidence recording. Keep this
  // extension alive for Pi's pre-tool block hook, which is the safe place to
  // stop side effects, but avoid duplicate prompt/provider entries.
  const hostOnly = process.env.PI_CONTINUITY_HOST === "1";
  let store;
  let taskId;
  let cwd;
  let branch;
  const mode = process.env.PI_CONTINUITY_MODE ?? "off";
  const budget = Number(process.env.PI_CONTINUITY_BUDGET ?? 12000);
  const redact = value => Array.isArray(value) ? value.map(redact) : (value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k,v]) => [/(?:api[-_]?key|authorization|token|password|secret)/i.test(k) ? k : k, /(?:api[-_]?key|authorization|token|password|secret)/i.test(k) ? "[REDACTED]" : redact(v)])) : value);

  function ensure(ctx, firstPrompt) {
    cwd ??= ctx.cwd ?? process.cwd();
    branch ??= (() => { try { return execFileSync("git", ["-C", cwd, "branch", "--show-current"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "detached"; } catch { return "unknown"; } })();
    if (!store) {
      const dir = join(cwd, ".pi");
      mkdirSync(dir, { recursive: true });
      store = new ContinuityStore(join(dir, "continuity.db"), { mode });
      const pointer = join(dir, "continuity-task.json");
      if (existsSync(pointer)) {
        try { taskId = JSON.parse(readFileSync(pointer, "utf8")).taskId; store.getTask(taskId, cwd, branch); } catch { taskId = undefined; }
      }
    }
    // session_start may initialize the store before the first user prompt.
    // Create the task lazily when raw input arrives in that same session.
    if (!taskId && firstPrompt) {
      taskId = store.createTask(cwd, branch, firstPrompt).task_id;
      writeFileSync(join(cwd, ".pi", "continuity-task.json"), JSON.stringify({ taskId }, null, 2));
    }
    return taskId ? store.getTask(taskId, cwd, branch) : undefined;
  }

  pi.on("session_start", async (_event, ctx) => {
    const task = ensure(ctx);
    if (task && _event?.reason === "resume") {
      const cp = store.status(task.task_id).checkpoint;
      const listed = cp ? store.checkpoint(cp.checkpoint_id)?.payload?.workspace?.files : undefined;
      const filePaths = Array.isArray(listed) ? listed.map(x => typeof x === "string" ? x : x?.path).filter(Boolean) : [];
      if (filePaths.length) {
        const current = store.captureWorkspace(cwd, filePaths);
        const check = store.compareWorkspace(store.checkpoint(cp.checkpoint_id).payload.workspace, current);
        if (check.status !== "match") {
          try { store.transition(task.task_id, "RECOVERY_REQUIRED", `workspace ${check.status}: ${check.reason}`); } catch {}
          ctx.ui?.notify?.(`Continuity recovery required: workspace ${check.reason}`, "error");
        }
      }
    }
    if (ctx.ui?.setStatus) ctx.ui.setStatus("continuity", `continuity: ${mode}`);
  });

  // Raw input is the authoritative user evidence. "continue" is recorded and
  // does not replace the original contract.
  pi.on("input", async (event, ctx) => {
    if (hostOnly) return;
    const task = ensure(ctx, event.text);
    if (!task) return;
    store.recordEvent(task.task_id, "user_input", { text: event.text }, { epoch: task.epoch });
    if (mode === "active") {
      try { store.buildManifest(task.task_id, { budget }); }
      catch (error) { ctx.ui?.notify?.(`Continuity gate: ${error.message}`, "error"); return { action: "handled" }; }
    }
  });

  // This is the real Pi pre-agent integration point. The injected message is
  // traceable to an immutable manifest; UI-only status never enters context.
  pi.on("before_agent_start", async (event, ctx) => {
    const task = ensure(ctx, event.prompt);
    // Record mode persists lifecycle evidence but must preserve Pi's native
    // request exactly; only active mode owns context injection.
    if (hostOnly || !task || mode !== "active") return;
    const manifest = store.buildManifest(task.task_id, { budget });
    store.recordEvent(task.task_id, "model_request", { manifestId: manifest.manifestId }, { epoch: task.epoch });
    return { message: { customType: "continuity", content: JSON.stringify(manifest), display: false } };
  });

  pi.on("before_provider_request", async (event, ctx) => {
    if (hostOnly) return;
    const task = ensure(ctx);
    if (task && mode !== "off") store.recordEvent(task.task_id, "provider_request", { payload: redact(event.payload) }, { epoch: task.epoch });
  });

  pi.on("tool_call", async (event, ctx) => {
    const task = ensure(ctx);
    if (!task || mode === "off") return;
    const opId = `${task.task_id}:${task.epoch}:${event.toolCallId}`;
    try {
      const oid = store.beginOperation(task.task_id, task.epoch, "pi_tool", opId);
      const operation = store.operation(oid);
      if (operation?.status === "unknown") return { block: true, reason: `Continuity operation ${oid} is unknown; reconcile before retry`, terminate: true };
      store.recordEvent(task.task_id, "tool_call", { toolName: event.toolName, input: event.input, opId }, { epoch: task.epoch, opId });
      store.recordWork(task.task_id, "pi_tool_execution_intent", { toolName: event.toolName, opId, input: event.input }, { epoch: task.epoch });
    } catch (error) {
      return { block: true, reason: `Continuity tool gate: ${error.message}`, terminate: true };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const task = ensure(ctx);
    if (task && mode !== "off") {
      const opId = `${task.task_id}:${task.epoch}:${event.toolCallId}`;
      try { store.finishOperation(task.task_id, task.epoch, opId, event.isError ? "failed" : "succeeded", event.result); }
      catch (error) { store.recordEvent(task.task_id, "tool_result", { toolCallId: event.toolCallId, result: event.result, error: String(error) }, { epoch: task.epoch, availability: "incomplete" }); }
    }
  });

  pi.on("session_before_switch", async (_event, ctx) => {
    const task = ensure(ctx);
    if (task && mode === "active") store.recordWork(task.task_id, "session_switch", { reason: "Pi session switch" }, { epoch: task.epoch });
  });

  pi.registerCommand("continuity", {
    description: "Show or inspect continuity state; resume requires confirmation",
    handler: async (args, ctx) => {
      const task = ensure(ctx);
      if (!task) return ctx.ui?.notify?.("No continuity task yet; send a prompt first.", "info");
      const status = store.status(task.task_id);
      const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      if (!parts.length || parts[0] === "status") return ctx.ui?.notify?.(`continuity ${status.mode} task=${status.taskId} epoch=${status.epoch} revision=${status.contractRevision} state=${status.runtime?.state} checkpoint=${status.checkpoint?.checkpoint_id ?? "none"}`, "info");
      const checkpointId = parts[1] ?? status.checkpoint?.checkpoint_id;
      if (parts[0] === "inspect") return ctx.ui?.notify?.(JSON.stringify(store.inspect(checkpointId, task.task_id).payload), "info");
      if (parts[0] === "diff") {
        const inspected = store.inspect(checkpointId, task.task_id);
        const selected = (inspected.payload.workspace?.files ?? []).map(x => typeof x === "string" ? x : x.path).filter(Boolean);
        const current = store.captureWorkspace(cwd, selected);
        return ctx.ui?.notify?.(JSON.stringify(store.compareWorkspace(inspected.payload.workspace, current)), "info");
      }
      if (parts[0] === "correct") {
        if (!ctx.ui?.confirm || !(await ctx.ui.confirm("Apply contract correction?", "This creates a new confirmed contract revision."))) return;
        let change;
        try { change = JSON.parse(parts.slice(1).join(" ")); } catch { return ctx.ui?.notify?.("Usage: /continuity correct {\"constraints\":[\"...\"]}", "error"); }
        const current = store.getTask(task.task_id);
        const corrected = store.correct(task.task_id, current.revision, current.epoch, { ...change, sourceEvent: { actor: "host", id: `pi-correct-${Date.now()}` } });
        return ctx.ui.notify(`Contract revision ${corrected.revision} confirmed`, "info");
      }
      if (parts[0] === "resume") {
        if (!ctx.ui?.confirm || !(await ctx.ui.confirm("Resume checkpoint?", `This creates a new epoch from ${checkpointId}.`))) return;
        const resumed = store.forkResume(checkpointId, task.task_id, task.revision, { mode: parts.includes("--practical") ? "practical" : "strict" });
        return ctx.ui.notify(`Resumed ${resumed.mode} at epoch ${resumed.epoch}`, "info");
      }
      ctx.ui?.notify?.("Usage: /continuity [status|inspect <checkpoint>|diff <checkpoint>|correct <json>|resume <checkpoint> [--practical]]", "info");
    },
  });

  pi.on("session_shutdown", async () => { store?.close(); store = undefined; taskId = undefined; cwd = undefined; branch = undefined; });
}
