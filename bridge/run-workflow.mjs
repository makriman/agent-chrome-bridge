import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ApprovalRequired, BrowserClient, configureBrowser } from "./sdk.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const RUNS_DIR = join(ROOT, "artifacts", "runs");

const args = process.argv.slice(2);
const workflowArg = args.find((arg) => !arg.startsWith("--"));

function flag(name) {
  return args.includes(name);
}

function flagValue(name, fallback = undefined) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function usage() {
  console.error(`Usage:
  node bridge/run-workflow.mjs <workflow.mjs|workflow.json> [options]

Options:
  --name <name>       Human-readable run name.
  --run-dir <path>    Existing/new run directory.
  --resume            Resume a paused or failed run.
  --dry-run           Emit steps without sending browser commands.
  --offline           Do not call the bridge at all; implies dry-run behavior.
  --plan              Print workflow metadata without running steps.
  --approve           Auto-grant approval gates for this run.
  --timeout <ms>      Default command timeout, default 30000.
  --quiet             Do not mirror JSONL events to stdout.`);
}

function nowIso() {
  return new Date().toISOString();
}

function slug(value) {
  return String(value || "workflow")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "workflow";
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function latestRunDir(runName) {
  await mkdir(RUNS_DIR, { recursive: true });
  const prefix = slug(runName);
  const entries = await readdir(RUNS_DIR, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(`_${prefix}`))
    .map((entry) => join(RUNS_DIR, entry.name))
    .sort()
    .reverse();
  return candidates[0] || null;
}

async function prepareRunDir(workflowPath, runName) {
  if (flagValue("--run-dir")) return resolve(ROOT, flagValue("--run-dir"));
  if (flag("--resume")) {
    const latest = await latestRunDir(runName);
    if (latest) return latest;
  }
  return join(RUNS_DIR, `${timestampSlug()}_${slug(runName)}`);
}

async function loadState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (_) {
    return {
      status: "created",
      createdAt: nowIso(),
      completedSteps: {},
      paused: null
    };
  }
}

async function saveState(statePath, state) {
  state.updatedAt = nowIso();
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

function redactError(error) {
  return {
    name: error.name,
    message: error.message,
    status: error.status || null,
    commandId: error.command ? error.command.id : null,
    commandStatus: error.command ? error.command.status : null
  };
}

function stepIdFrom(step, index) {
  return step.id || `${String(index + 1).padStart(3, "0")}-${slug(step.op || step.name || "step")}`;
}

async function writeSummary(runDir, summary) {
  await writeFile(
    join(runDir, "summary.md"),
    [
      `# ${summary.name}`,
      "",
      `- Status: ${summary.status}`,
      `- Started: ${summary.startedAt}`,
      `- Finished: ${summary.finishedAt || ""}`,
      `- Workflow: ${summary.workflowPath}`,
      summary.error ? `- Error: ${summary.error.message}` : "",
      ""
    ]
      .filter(Boolean)
      .join("\n")
  );
}

async function main() {
  if (!workflowArg) {
    usage();
    process.exit(2);
  }

  const workflowPath = resolve(process.cwd(), workflowArg);
  const workflowName = flagValue("--name", basename(workflowPath, extname(workflowPath)));
  const runDir = await prepareRunDir(workflowPath, workflowName);
  await mkdir(runDir, { recursive: true });
  await mkdir(join(runDir, "screenshots"), { recursive: true });
  await mkdir(join(runDir, "inspect"), { recursive: true });
  await mkdir(join(runDir, "approvals"), { recursive: true });

  const eventsPath = join(runDir, "events.jsonl");
  const commandLogPath = join(runDir, "command-log.jsonl");
  const statePath = join(runDir, "state.json");
  const state = await loadState(statePath);
  const quiet = flag("--quiet");
  const pendingSinkEvents = new Set();
  let emitChain = Promise.resolve();

  async function appendJsonl(path, event) {
    await writeFile(path, `${JSON.stringify(event)}\n`, { flag: "a" });
  }

  async function emit(event) {
    const payload = { at: nowIso(), runDir, workflow: workflowName, ...event };
    emitChain = emitChain.then(async () => {
      await appendJsonl(eventsPath, payload);
      if (payload.type && payload.type.startsWith("command_")) {
        await appendJsonl(commandLogPath, payload);
      }
      if (!quiet) console.log(JSON.stringify(payload));
    });
    await emitChain;
  }

  function sink(event) {
    const pending = emit(event)
      .catch(() => {})
      .finally(() => pendingSinkEvents.delete(pending));
    pendingSinkEvents.add(pending);
  }

  async function flushSink() {
    await Promise.allSettled(Array.from(pendingSinkEvents));
  }

  const client = new BrowserClient({
    runDir,
    root: ROOT,
    dryRun: flag("--dry-run") || flag("--offline"),
    offline: flag("--offline"),
    approve: flag("--approve"),
    commandTimeoutMs: Number(flagValue("--timeout", 30000)),
    eventSink: sink
  });
  configureBrowser({
    runDir,
    root: ROOT,
    dryRun: flag("--dry-run") || flag("--offline"),
    offline: flag("--offline"),
    approve: flag("--approve"),
    commandTimeoutMs: Number(flagValue("--timeout", 30000)),
    eventSink: sink
  });

  const context = {
    runDir,
    state,
    browser: client,
    emit,
    async step(id, titleOrFn, maybeFn, options = {}) {
      const title = typeof titleOrFn === "function" ? id : titleOrFn;
      const fn = typeof titleOrFn === "function" ? titleOrFn : maybeFn;
      if (!fn) throw new Error(`Step ${id} has no function.`);
      if (flag("--resume") && state.completedSteps[id]) {
        await emit({ type: "step_skipped", stepId: id, title, reason: "already completed" });
        return state.completedSteps[id].result;
      }
      const retries = Number(options.retries || 0);
      let attempt = 0;
      while (attempt <= retries) {
        attempt += 1;
        await emit({ type: "step_started", stepId: id, title, attempt });
        try {
          const result = await fn();
          state.completedSteps[id] = { completedAt: nowIso(), result: result ?? null };
          state.status = "running";
          state.paused = null;
          await saveState(statePath, state);
          await emit({ type: "step_succeeded", stepId: id, title, attempt, result: result ?? null });
          return result;
        } catch (error) {
          await emit({ type: "step_failed", stepId: id, title, attempt, error: redactError(error) });
          if (error instanceof ApprovalRequired) throw error;
          if (options.optional) {
            const optionalResult = { optional: true, skipped: true, error: redactError(error) };
            state.completedSteps[id] = { completedAt: nowIso(), result: optionalResult };
            await saveState(statePath, state);
            await emit({ type: "step_optional_failed", stepId: id, title, attempt, result: optionalResult });
            return optionalResult;
          }
          if (attempt > retries) {
            await captureFailureArtifacts(client, runDir, id);
            throw error;
          }
        }
      }
      return null;
    }
  };

  const summary = {
    name: workflowName,
    status: "running",
    startedAt: state.startedAt || nowIso(),
    workflowPath
  };

  state.workflowPath = workflowPath;
  state.runDir = runDir;
  state.status = "running";
  state.startedAt = state.startedAt || nowIso();
  await saveState(statePath, state);
  await copyFile(workflowPath, join(runDir, `workflow${extname(workflowPath)}`)).catch(() => {});
  await emit({
    type: "workflow_started",
    workflowPath,
    dryRun: flag("--dry-run") || flag("--offline"),
    offline: flag("--offline"),
    plan: flag("--plan"),
    resume: flag("--resume"),
    approve: flag("--approve")
  });

  if (flag("--plan")) {
    const plan = extname(workflowPath) === ".json" ? JSON.parse(await readFile(workflowPath, "utf8")) : null;
    await emit({
      type: "workflow_plan",
      workflowPath,
      steps: plan && Array.isArray(plan.steps) ? plan.steps.map((step, index) => ({ id: stepIdFrom(step, index), op: step.op })) : null,
      note: plan ? "JSON workflow plan only; no steps executed." : "JavaScript workflows cannot be statically expanded; no steps executed."
    });
    state.status = "planned";
    await saveState(statePath, state);
    await flushSink();
    return;
  }

  try {
    if (extname(workflowPath) === ".json") {
      const plan = JSON.parse(await readFile(workflowPath, "utf8"));
      await runJsonPlan(plan, context);
    } else {
      const module = await import(`${pathToFileURL(workflowPath).href}?run=${Date.now()}`);
      const run = module.default || module.run;
      if (typeof run !== "function") {
        throw new Error("Workflow module must export a default async function or named run function.");
      }
      await run(context);
    }
    state.status = "succeeded";
    state.paused = null;
    await saveState(statePath, state);
    summary.status = "succeeded";
    summary.finishedAt = nowIso();
    await emit({ type: "workflow_succeeded" });
    await flushSink();
    await writeSummary(runDir, summary);
  } catch (error) {
    if (error instanceof ApprovalRequired) {
      state.status = "paused";
      state.paused = error.approval;
      await saveState(statePath, state);
      summary.status = "paused";
      summary.finishedAt = nowIso();
      summary.error = redactError(error);
      await emit({ type: "workflow_paused", approval: error.approval });
      await flushSink();
      await writeSummary(runDir, summary);
      process.exit(2);
    }
    state.status = "failed";
    state.error = redactError(error);
    await saveState(statePath, state);
    summary.status = "failed";
    summary.finishedAt = nowIso();
    summary.error = redactError(error);
    await emit({ type: "workflow_failed", error: redactError(error) });
    await flushSink();
    await writeSummary(runDir, summary);
    process.exit(1);
  }
}

async function captureFailureArtifacts(client, runDir, stepId) {
  const safeStep = slug(stepId);
  const failures = [];
  try {
    const inspect = await client.command({ type: "inspect", limit: 200, timeoutMs: 10000 });
    await writeFile(join(runDir, "inspect", `failure-${safeStep}.json`), JSON.stringify(inspect.result, null, 2));
  } catch (error) {
    failures.push({ artifact: "inspect", error: redactError(error) });
    // Failure artifacts should never mask the real workflow error.
  }
  try {
    await client.command({
      type: "screenshot",
      output: join(runDir, "screenshots", `failure-${safeStep}.png`),
      timeoutMs: 10000
    });
  } catch (error) {
    failures.push({ artifact: "screenshot", error: redactError(error) });
    // Failure artifacts should never mask the real workflow error.
  }
  if (failures.length > 0) {
    await writeFile(join(runDir, "failure-artifacts.json"), JSON.stringify({ stepId, failures }, null, 2)).catch(() => {});
  }
}

async function runJsonPlan(plan, context) {
  const tab = await context.browser.useProfile(plan.profile || "default");
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const id = stepIdFrom(step, index);
    await context.step(id, step.name || step.op, () => runJsonStep(tab, step, context), {
      retries: step.retries || 0,
      optional: Boolean(step.optional)
    });
  }
}

async function runJsonStep(tab, step, context) {
  if (step.op === "inspect") {
    const result = await tab.inspect(step.limit || 120);
    if (step.saveAs) {
      await writeFile(join(context.runDir, "inspect", `${slug(step.saveAs)}.json`), JSON.stringify(result, null, 2));
    }
    return result;
  }
  if (step.op === "screenshot") return tab.screenshot(step.output || join(context.runDir, "screenshots", `${Date.now()}.png`));
  if (step.op === "click") return runClickStep(tab, step);
  if (step.op === "fill") return runFillStep(tab, step);
  if (step.op === "type") return tab.type(step.text || "");
  if (step.op === "key" || step.op === "press") return tab.press(step.key, step.modifiers || []);
  if (step.op === "scroll") return tab.scroll(step.deltaY || 700);
  if (step.op === "navigate") return tab.navigate(step.url);
  if (step.op === "waitFor") return runWaitForStep(tab, step);
  if (step.op === "assert") return runAssertStep(tab, step);
  if (step.op === "requireApproval") return tab.requireApproval(step.reason || "Continue workflow", step.details || {});
  if (step.op === "raw") {
    const command = await context.browser.command(step.command || {});
    return command.result;
  }
  throw new Error(`Unsupported JSON workflow op: ${step.op}`);
}

async function runClickStep(tab, step) {
  const by = step.by || {};
  if (by.ref || step.ref) return tab.clickRef(by.ref || step.ref, step.options || {});
  if (by.selector || step.selector) return tab.clickBySelector(by.selector || step.selector, step.options || {});
  if (by.role || step.role) return tab.clickByRole(by.role || step.role, by.name || step.name || "", step.options || {});
  if (by.text || step.text) return tab.clickByText(by.text || step.text, step.options || {});
  throw new Error("Click step requires by.ref, by.selector, by.role/name, or by.text.");
}

async function runFillStep(tab, step) {
  const by = step.by || {};
  if (by.ref || step.ref) return tab.fillRef(by.ref || step.ref, step.text || "");
  if (by.text || step.targetText) {
    const item = await tab.findByText(by.text || step.targetText);
    return tab.fillRef(item.ref, step.text || "");
  }
  throw new Error("Fill step requires by.ref or by.text target.");
}

async function runWaitForStep(tab, step) {
  const kind = step.kind || (step.text ? "text" : step.selector ? "selector" : step.url ? "url" : "");
  const value = step.value || step.text || step.selector || step.url || "";
  if (kind === "text") return tab.waitForText(value, step.options || {});
  if (kind === "selector") return tab.waitForSelector(value, step.options || {});
  if (kind === "url") return tab.waitForUrl(value, step.options || {});
  throw new Error("waitFor step requires kind text, selector, or url.");
}

async function runAssertStep(tab, step) {
  if (step.url) return tab.assertUrl(step.url);
  if (step.text) return tab.assertText(step.text, step.options || {});
  if (step.selector) return tab.assertSelector(step.selector, step.options || {});
  throw new Error("assert step requires url, text, or selector.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
