import { APICallError, RetryError } from "ai";
import { buildExecPrompt, type ExecInputStream } from "./exec-input.js";
import { runAgent } from "./agent.js";
import { buildRepoMap } from "./prompt.js";
import { executeTool, registry, setSessionId, setSignal, setTimeoutToBackground, setSandboxLevel, setWriteRoots, setWebSearchConfig } from "./tools/index.js";
import { filterToolDefs } from "./tools/filter.js";
import { todoStore } from "./tools/todo.js";
import { initPresets, createProvider, getPreset } from "./providers/presets.js";
import { imageSupportWarning } from "./providers/registry.js";
import { PermissionEngine, ProfileEvaluator, authorize } from "./permissions/index.js";
import { projectSettingsPath } from "./config/paths.js";
import { expandFileMentions } from "./ui/core/file-mentions.js";
import { ErrorRecovery } from "./errorrecovery/index.js";
import { ErrorReflector } from "./selfreflection/index.js";
import { fireNotify } from "./notify.js";
import { HookRunner, fireNotificationHooks } from "./hooks/index.js";
import { Orchestrator } from "./orchestrator/index.js";
import { ModeLoader } from "./modes/loader.js";
import { AgentLoader } from "./agents/index.js";
import { join } from "node:path";
import { checkSettingsTrust, stripExecutionKeys, trustSettings } from "./config/settings-trust.js";
import { GENERAL_MODEL_ID, GENERAL_REASONING_EFFORT, parseModelId } from "./modes/model-policy.js";

export interface ExecRunnerOptions {
  prompt: string;
  projectRoot: string;
  resumeSessionId?: string;
  mode?: string;
  model?: string;
  debug?: boolean;
  /** Startup-resolved directories explicitly trusted via --add-dir. */
  additionalWriteRoots?: string[];
  /** Cap agentic turns; reaching it exits non-zero (flag parity --max-turns). */
  maxTurns?: number;
  /** Restrict the offered tool set to exactly these names (--allowed-tools). */
  allowedTools?: string[];
  /** Remove these tool names from the offered set (--disallowed-tools). */
  disallowedTools?: string[];
  input?: ExecInputStream;
}

// All headless diagnostics go straight to process.stderr as single lines — never
// through console.error, which the AI SDK also uses for its full-object dump.
function writeErr(line: string): void {
  process.stderr.write(`${line}\n`);
}

// Turn an AI SDK / provider error into a single concise line: status code and the
// provider's own message when present, unwrapping the retry wrapper. The full
// object (stack, request body, headers) is only useful with --debug (B6).
function conciseProviderError(err: unknown): string {
  let e = err;
  if (RetryError.isInstance(e) && e.lastError) e = e.lastError;
  if (APICallError.isInstance(e)) {
    const status = e.statusCode ? `HTTP ${e.statusCode}: ` : "";
    return `${status}${e.message}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export async function runExecMode(options: ExecRunnerOptions): Promise<number> {
  initPresets();
  let interrupted = false;

  // Hoisted so the finally block can kill pending sub-runs on every exit path
  // (async-subagents.md §3, Q3 — die on exit).
  let orchestrator: Orchestrator | undefined;

  const handleSigint = () => {
    interrupted = true;
  };
  process.on("SIGINT", handleSigint);

  // The AI SDK's streamText installs a default onError that does
  // `console.error(error)`, dumping the entire error object (stack, request
  // body, headers) before the failure surfaces through our own catch (B6). In
  // headless mode we want a single concise line, so we suppress that dump unless
  // --debug is set. Our own output uses process.stderr directly, so silencing
  // console.error does not touch it. Restored in `finally`.
  const originalConsoleError = console.error;
  if (!options.debug) {
    console.error = () => {};
  }

  try {
    const { loadConfig } = await import("./config/loader.js");
    const configResult = loadConfig(options.projectRoot);
    // Fail fast on config errors, same message shape as the TUI (cli.tsx) —
    // e.g. an invalid matcher regex is fatal in headless mode too; it must
    // never degrade to a silently match-ALL hook (fix 5).
    if (configResult.errors.length > 0) {
      for (const e of configResult.errors) writeErr(`Error: ${e}`);
      return 1;
    }

    // Folder-level "fast path" trust (config/folder-trust.ts) is
    // INTENTIONALLY not wired here: headless must never auto-trust a folder
    // (there's no one to ask), so it never calls checkFolderTrust/
    // trustFolder/the prompt. It does NOT need to — a folder previously
    // trusted in an interactive session already bulk-wrote into
    // skill-trust.json / settings-trust.json / hooks-trust.json, the exact
    // same stores the three gates below (and SkillLoader / HookRunner) read
    // independently of folder trust. So a prior interactive "yes" is honored
    // here transparently, per-artifact, while an unseen/edited/added artifact
    // still fails closed exactly as it did before folder trust existed.

    // Execution-capable project settings (statusline/mcpServers/notify/
    // env.BASE_URL) require explicit trust before they take effect — same
    // TOFU gate as hooks/skills. Headless has no one to ask, so an unseen or
    // changed project settings file fails closed: the keys are stripped and a
    // single stderr warning names them, mirroring skills/index.ts's headless
    // untrusted-skill skip.
    let effectiveConfig = configResult.config;
    if (configResult.projectExecutionKeys.length > 0) {
      const projectSettingsFile = projectSettingsPath(options.projectRoot);
      const trust = checkSettingsTrust(projectSettingsFile);
      if (trust.status !== "trusted") {
        writeErr(
          `[warn] Untrusted project settings (${trust.status}) — skipping execution-capable keys: ${configResult.projectExecutionKeys.join(", ")} (${projectSettingsFile})`,
        );
        effectiveConfig = stripExecutionKeys(configResult.config, configResult.projectExecutionKeys);
      }
    }

    const configEnv = effectiveConfig.env;
    const writeRoots = [...(effectiveConfig.sandbox?.writeRoots ?? []), ...(options.additionalWriteRoots ?? [])];
    const notifyScript = effectiveConfig.notify;
    // commands.timeoutToBackground (plan §3, default ON) — same default
    // resolution the TUI uses; run_bash migration works identically headless.
    setTimeoutToBackground(configResult.config.commands?.timeoutToBackground ?? true);

    // sandbox (permission-profile.md §8, phase (e)) — same resolution the
    // TUI uses; Seatbelt enforcement is identical headless.
    setSandboxLevel(
      effectiveConfig.sandbox?.enabled &&
      effectiveConfig.permissionProfile &&
      effectiveConfig.permissionProfile.level !== "unrestricted"
        ? effectiveConfig.permissionProfile.level
        : undefined,
    );
    // Merge global sandbox.writeRoots with the startup-resolved --add-dir
    // roots. Project TOFU stripping can narrow only the config contribution;
    // explicit CLI roots remain session-scoped trusted roots.
    setWriteRoots(writeRoots);

    // web_search backend config (webSearch.searxngUrl) — resolved from the
    // EFFECTIVE (post-TOFU-strip) config, same as sandbox/permissions above.
    // web-search.ts reads this via ToolContext instead of calling
    // loadConfig() itself, which would bypass this gate.
    setWebSearchConfig(effectiveConfig.webSearch);

    const resolvedApiKey = configEnv?.API_KEY || undefined;
    const resolvedBaseUrl = configEnv?.BASE_URL || undefined;

    let providerName = configResult.config.provider || "deepseek";
    const rawModel = options.model ?? configResult.config.model ?? configEnv?.MODEL ?? undefined;
    const parsedModel = parseModelId(rawModel, providerName);
    if (rawModel?.includes("/") && parsedModel) providerName = parsedModel.provider;
    let activeModel: string | undefined = parsedModel?.model;

    if (options.resumeSessionId && !rawModel) {
      activeModel = undefined;
    }

    // Resolve the active mode before touching the provider so a typo fails
    // with a clear "unknown mode" message instead of silently proceeding or
    // crashing later (B1/D7). An explicit --mode wins; otherwise the same
    // "general" default the TUI starts new sessions with (src/cli.tsx) — so
    // headless runs get the same tool gating as an unconfigured TUI session
    // instead of registry.getAllDefs()'s every-tool fallback.
    const modeLoader = new ModeLoader();
    const activeMode = await modeLoader.load(options.mode || "general", options.projectRoot);
    if (!activeMode) {
      const available = (await modeLoader.listAll(options.projectRoot)).map((m) => m.slug).sort();
      writeErr(`Error: unknown mode "${options.mode || "general"}", available: ${available.join(", ")}`);
      return 1;
    }

    // General has a deliberately cheap provider default. An explicit model,
    // configured provider, or configured effort remains authoritative.
    if (!rawModel && activeMode.slug === "general") {
      const modeModel = parseModelId(activeMode.model || GENERAL_MODEL_ID, providerName);
      if (modeModel && (!configResult.config.provider || configResult.config.provider === modeModel.provider)) {
        providerName = modeModel.provider;
        activeModel = modeModel.model;
      }
    }
    const activeCaps = getPreset(providerName)?.models[activeModel ?? getPreset(providerName)?.defaultModel ?? ""];
    const activeEffort = configResult.config.reasoningEffort
      ?? (activeMode.slug === "general" && activeCaps?.effort
        ? (activeMode.reasoningEffort || GENERAL_REASONING_EFFORT)
        : activeMode.slug === "general" ? undefined : activeCaps?.effort?.default);

    // createProvider throws for an unknown provider or a missing API key. In
    // headless mode that must be a clean one/two-line message telling the user
    // what to do (run `nib auth`), not a raw Node stack trace (B1).
    let provider;
    try {
      provider = createProvider(providerName, {
        modelOverride: activeModel,
        baseUrl: resolvedBaseUrl,
        apiKey: resolvedApiKey,
      });
    } catch (err) {
      writeErr(`Error: ${(err as Error).message}`);
      return 1;
    }

    let prompt: string;
    try {
      prompt = await buildExecPrompt(options.prompt, options.input ?? process.stdin);
    } catch (err) {
      writeErr(`Error: ${(err as Error).message}`);
      return 1;
    }
    if (interrupted) return 130;

    const abortController = new AbortController();
    setSignal(abortController.signal);

    // Same construction the TUI uses (cli.tsx). Headless mode does not remove
    // the permission engine — explicit allow rules and defaultMode still apply,
    // and the destructive-tier deny stays absolute. It only removes the human:
    // any rule resolving to `ask` (including the guarded tier and unresolved
    // bash segments) has no one to prompt, so the askUser below fails closed —
    // it denies and prints one stderr line so a scripted user knows why a run
    // did less than expected. See docs/permission-spec.md § Headless Interaction.
    const permissions = new PermissionEngine(
      effectiveConfig.permissions,
      options.projectRoot,
      Object.keys(effectiveConfig.mcpServers ?? {}).length > 0,
      {
        // docs/unified-write-boundary.md §2: same boundary as the TUI —
        // active whenever the profile level is workspace-write, threading the
        // global-only sandbox.writeRoots into the shared write-set.
        enforceWriteBoundary: effectiveConfig.permissionProfile?.level === "workspace-write",
        writeRoots,
        // Re-record the TOFU trust hash after every persisted "always"
        // approval, same as the TUI (cli.tsx) — headless is still the
        // user's own process, so persist()'s self-write is not a tamper
        // signal. Without this, a headless "always" approval would make the
        // NEXT run treat its own settings.json as untrusted-changed and strip
        // the `permissions` key, silently discarding the approval.
        onPersist: (settingsPath) => trustSettings(settingsPath),
      },
    );
    // Same construction the TUI uses (cli.tsx): loadConfig supplies a
    // workspace-write profile by default. A profile deny fails closed exactly
    // like a rule deny (no prompt; the headless askUser below is never reached).
    const permissionProfile = new ProfileEvaluator(effectiveConfig.permissionProfile!, options.projectRoot, {
      writeRoots,
    });

    // Lifecycle hooks (hooks-spec.md): headless mode skips untrusted project
    // hooks with a stderr warning at startup (fail closed, like skills).
    const hooks = new HookRunner({
      config: configResult.config.hooks,
      disableAllHooks: configResult.config.disableAllHooks,
      headless: true,
      debug: options.debug,
      cwd: options.projectRoot,
      sessionId: () => options.resumeSessionId,
      getPermissionMode: () => "headless",
    });
    hooks.verifyTrust();
    const askUser = async (toolName: string, args: Record<string, unknown>): Promise<boolean> => {
      const subject =
        toolName === "run_bash"
          ? String(args?.command ?? "")
          : String(args?.path ?? args?.filePath ?? args?.query ?? "");
      writeErr(`permission denied (headless): ${toolName} ${subject}`);
      return false;
    };

    // Agent definitions (feature-plans.md §F4): loaded once per headless run,
    // project > global; new_task's `agent` parameter resolves through this.
    const agentLoader = new AgentLoader();
    const agents = await agentLoader.load(options.projectRoot);

    // Orchestrator mode (9.3): register once per headless run so `-p` prompts
    // can use new_task too. Sub-agents inherit this run's provider, permission
    // engine (rules + approval posture — no escalation, 24.3), and the
    // fail-closed headless askUser above. getSignal forwards the run's
    // AbortController so SIGINT/Ctrl+C cancels an in-flight sub-agent. A
    // defined agent's "provider/model" override creates a provider bound to
    // that model; the startup key/host stays scoped to this run's provider.
    orchestrator = new Orchestrator({
      provider: (modelId?: string) => {
        if (!modelId) return provider;
        const slash = modelId.indexOf("/");
        const provName = modelId.slice(0, slash);
        return createProvider(provName, {
          modelOverride: modelId.slice(slash + 1),
          baseUrl: provName === providerName ? resolvedBaseUrl : undefined,
          apiKey: provName === providerName ? resolvedApiKey : undefined,
        });
      },
      registry,
      modeLoader: new ModeLoader(),
      agents: agentLoader,
      permissions,
      profile: permissionProfile,
      askUser,
      getSignal: () => abortController.signal,
      hooks,
    });
    orchestrator.register(registry);

    // Async sub-agent delivery (async-subagents.md §2): a completed sub-run's
    // result lands here and the wake loop below feeds it to the next turn.
    const pendingResults: string[] = [];
    orchestrator.setOnTaskResult((_taskId, message) => {
      pendingResults.push(message);
    });

    // Notify hook fires from this completion boundary (turn outcome is
    // definitively known here) for headless `-x` runs, mirroring the
    // interactive site in cli.tsx. Fire-and-forget — see src/notify.ts.
    const notifyStart = Date.now();
    const notifyTitle = options.prompt.slice(0, 120);
    // Repository map: computed once per headless run, injected into the stable
    // preamble. Degrades to undefined (no map) on any failure — never crashes.
    const repomapInjection = (await buildRepoMap(options.projectRoot)) ?? undefined;

    // SessionStart fires once at startup, after the trust check, before the
    // first turn (hooks-spec.md §2).
    await hooks.dispatch("SessionStart", {});

    // UserPromptSubmit fires before the message enters the agent; a block
    // means the message is not sent and the user is notified (headless: one
    // stderr line + non-zero exit). Exit-0 stdout appends to the prompt.
    const ups = await hooks.dispatch("UserPromptSubmit", { prompt });
    if (ups.blocked) {
      writeErr("UserPromptSubmit hook blocked the message");
      return 1;
    }
    const finalPrompt = ups.stdout.trim() !== "" ? `${prompt}\n\n${ups.stdout.trimEnd()}` : prompt;

    // `@file` / `@image.png` mentions: the same expansion the TUI does
    // (cli.tsx), so headless is not a second-class path where a mention
    // silently does nothing. Gated identically — a path the profile or a read
    // rule denies is noted in place of its contents, never injected. Images
    // ride `imageUrls`, the only channel that delivers image bytes to the
    // provider; a text `<file>` block would hand the model base64 garbage.
    const { blocks: mentionBlocks, imageUrls: mentionImageUrls } = await expandFileMentions(
      finalPrompt,
      options.projectRoot,
      (raw) => (authorize({ tool: "read_file", arguments: { path: raw } }, permissions, permissionProfile).action === "deny" ? "deny" : "allow"),
    );
    const expandedPrompt = mentionBlocks.length > 0
      ? `${mentionBlocks.join("\n\n")}\n\n${finalPrompt}`
      : finalPrompt;

    // Same vision caveat the TUI surfaces: headless has no one to notice a
    // silently-ignored image, so it says so on stderr.
    const visionWarning = imageSupportWarning(providerName, activeModel, mentionImageUrls.length);
    if (visionWarning) writeErr(`[warn] ${visionWarning}`);

    try {
      // Layered failure handling (self-reflection + error recovery). Both
      // engage only on error paths inside runAgent — a failed tool result
      // triggers one reflection retry, malformed tool-call JSON or a fatal
      // turn exception triggers recovery — so the happy path is unaffected.
      // Constructed once per headless run so the reflector's total-retry
      // budget spans the whole session.
      // CLI --allowed-tools / --disallowed-tools (flag parity): narrow the
      // offered tool set before passing it to runAgent; empty lists pass
      // everything through. maxTurns from CLI caps agentic turns.
      const modeTools = activeMode.groups ? registry.getByMode(activeMode.groups) : registry.getAllDefs();
      const filteredTools = filterToolDefs(modeTools, options.allowedTools, options.disallowedTools);

      const agentOptions = {
        provider,
        tools: filteredTools,
        effort: activeEffort,
        executeTool,
        permissions,
        permissionProfile,
        askUser,
        agents,
        repomap: repomapInjection,
        signal: abortController.signal,
        maxTurns: options.maxTurns ?? 100,
        // Images referenced by `@path` in the prompt (see expandFileMentions);
        // absent for the wake-loop turns, which carry sub-agent results, not
        // user input.
        imageUrls: mentionImageUrls.length > 0 ? mentionImageUrls : undefined,
        errorReflector: new ErrorReflector(),
        errorRecovery: new ErrorRecovery(),
        getTodos: () => todoStore.getTodos(),
        hooks,
      };
      let result = await runAgent(expandedPrompt, agentOptions);

      // Async wake loop (async-subagents.md §2): a parent that ended its turn
      // after spawning keeps going until every sub-run has completed and every
      // delivered result has been processed. Results arriving while a turn
      // runs stay queued and feed the NEXT turn (headless has no steering
      // mailbox — the wake rule is "append + continue"). History threads
      // across turns, so the parent's context carries into each wake turn.
      while (true) {
        if (pendingResults.length > 0) {
          if (interrupted) return 130;
          result = await runAgent(pendingResults.shift()!, { ...agentOptions, history: result.messages });
          continue;
        }
        if (orchestrator.tasks.runningCount() > 0) {
          if (interrupted) return 130;
          await orchestrator.tasks.waitForNextCompletion();
          continue;
        }
        break;
      }

      if (interrupted) return 130;

      const lastReply = result.messages[result.messages.length - 1]?.content ?? "";
      process.stdout.write(lastReply);
      const completedNotifyInput = {
        status: "completed" as const,
        durationMs: Date.now() - notifyStart,
        body: lastReply,
        title: notifyTitle,
      };
      fireNotify(
        notifyScript,
        { ...completedNotifyInput, passthroughEnv: configEnv },
        { debug: options.debug },
      );
      // Notification hooks fire alongside the notify script (hooks-spec.md §7);
      // SessionEnd fires immediately after, before teardown.
      fireNotificationHooks(hooks, completedNotifyInput);
      await hooks.dispatch("SessionEnd", {});
      return result.stopReason === "done" ? 0 : 1;
    } catch (err) {
      if (interrupted) return 130;
      if (options.debug) {
        originalConsoleError(err);
      }
      const reason = conciseProviderError(err);
      writeErr(`Error: ${reason}`);
      const failedNotifyInput = {
        status: "failed" as const,
        durationMs: Date.now() - notifyStart,
        body: "",
        title: notifyTitle,
        failReason: reason,
      };
      fireNotify(
        notifyScript,
        { ...failedNotifyInput, passthroughEnv: configEnv },
        { debug: options.debug },
      );
      fireNotificationHooks(hooks, failedNotifyInput);
      await hooks.dispatch("SessionEnd", {});
      return 1;
    }
  } finally {
    // Die on exit (async-subagents.md §3, Q3): pending sub-runs are marked
    // aborted and never deliver into a dead loop; the process exit is the
    // actual kill.
    orchestrator?.tasks.abortAll();
    console.error = originalConsoleError;
    process.off("SIGINT", handleSigint);
  }
}
