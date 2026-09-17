import { render } from "ink";
import { readdirSync, realpathSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { pkg } from "./version.js";
import { parseArguments, resolveAdditionalDirs } from "./cli-args.js";
import { runExecMode } from "./exec-runner.js";
import { initPresets, createProvider, getPreset, getKnownProviderNames, getProviderModels, getConfiguredProviders, type ProviderOptions } from "./providers/presets.js";
import { getProviderCapabilities, imageSupportWarning } from "./providers/registry.js";
import { runAgent } from "./agent.js";
import { buildRepoMap, captureGitStatus, loadProjectResearch } from "./prompt.js";
import { compactionCutoffTokens, estimateTokens, estimateTokensDetailed, estimateOverheadTokens } from "./compaction/budget.js";
import { CONTEXT_EDITING_TRIGGER_TOKENS, RECENT_TOOL_RESULTS_TO_KEEP } from "./compaction/context-editing.js";
import { fireNotify, type NotifySpawnOptions } from "./notify.js";
import { HookRunner, fireNotificationHooks } from "./hooks/index.js";
import { executeTool, TOOL_DEFS, registry, setSessionId, setCheckpointManager, setSignal, setSessionStore, setSetMode, setTimeoutToBackground, setSandboxLevel, setSessionTempDir, setWritePolicyLevel, setWriteRoots, setWebSearchConfig } from "./tools/index.js";
import { createSessionTempDir } from "./sandbox/session-temp.js";
import { filterToolDefs } from "./tools/filter.js";
import { jobManager } from "./tools/jobs.js";
import { todoStore } from "./tools/todo.js";
import { PermissionEngine, ProfileEvaluator, authorize } from "./permissions/index.js";
import { previewEdit } from "./permissions/diffpreview.js";
import { ModeLoader, type ModeConfig } from "./modes/loader.js";
import { Compactor, keepBoundary } from "./compaction/compactor.js";
import { CheckpointManager } from "./checkpoints/index.js";
import { DiagnosticRunner } from "./diagnostics/index.js";
import { startStallWatchdog } from "./diagnostics/stall-watchdog.js";
import { ErrorReflector } from "./selfreflection/index.js";
import { ErrorRecovery } from "./errorrecovery/index.js";
import { Orchestrator, type SubagentProgress } from "./orchestrator/index.js";
import { authWizard, authList, authLogout, authSaveKey } from "./auth/wizard.js";
import { runModels } from "./providers/models-command.js";
import { readHiddenLine } from "./auth/hidden-input.js";
import { SessionStore, type CompactionSummary } from "./sessions/store.js";
import { MemoryStore } from "./memory/store.js";
import { SkillLoader, createLoadSkillTool, type SkillDef } from "./skills/index.js";
import { AgentLoader, type AgentDef } from "./agents/index.js";
import { CommandLoader, type CommandDef } from "./commands/index.js";
import { containmentWarning, hasActiveSandboxContainment, loadConfig, resolveHome, workspaceOutsideHomeWarning } from "./config/loader.js";
import { projectSettingsPath } from "./config/paths.js";
import { checkSettingsTrust, trustSettings, stripExecutionKeys } from "./config/settings-trust.js";
import { checkFolderTrust, trustFolder, buildFolderContentSummary, hasGatedContent } from "./config/folder-trust.js";
import { readCredentialsFile } from "./config/credentials.js";
import { enableDebug } from "./debug/logger.js";
import { connectMCPServers, disconnectAllMCPServers } from "./mcp/connector.js";
import App from "./ui/App.js";
import { ThemeProvider } from "./ui/contexts.js";
import SettingsTrustPrompt from "./ui/views/SettingsTrustPrompt.js";
import FolderTrustPrompt from "./ui/views/FolderTrustPrompt.js";
import type { Message } from "./types.js";
import type { ModelCapabilities, ProviderBalance } from "./providers/types.js";
import { resolveTheme, ThemeContextValue, ANSI, ansiFg, ANSI_RESET } from "./ui/theme.js";
import { chip, meter } from "./ui/core/chips.js";
import { buildTaskSegments } from "./ui/core/task-status.js";
import { ANSI_CLEAR_SCREEN } from "./ui/constants.js";
import { resolveRefreshProfile, REFRESH_PROFILE_NAMES, describeRefreshSource } from "./ui/core/refresh-rates.js";
import { installResizeRepaintFix } from "./ui/core/resize-repaint.js";
import { expandFileMentions } from "./ui/core/file-mentions.js";
import { BUILTIN_SLASH_COMMANDS } from "./ui/core/slash-commands.js";
import { probeSyncOutput } from "./terminal-probe.js";
import { resolveKeybindings, parseKeyCombo, type KeybindingMap, type KeybindingConfig as KeybindingSystemConfig } from "./ui/keybindings.js";
import type { WorkflowIntegrationConfig, ModelEntry } from "./ui/types.js";
import { StatusLineManager } from "./ui/statusline/index.js";
import { isSkillAlreadyLoaded, buildSkillLoadMessage } from "./ui/core/skill-load.js";
import { toModelId } from "./ui/core/model-picker.js";
import { loadFavoriteModels, loadRecentModels, persistRecentModel, persistToggleFavorite } from "./ui/components/ModelsDropdown/settings.js";
import { GENERAL_MODEL_ID, GENERAL_REASONING_EFFORT, parseModelId, resolveRestoredSelection } from "./modes/model-policy.js";

// Opt-in stall watchdog (NIB_PROFILE=1|true): started before the Ink
// render() call, stopped + reported inside logSessionEnd. Module-level so
// both logSessionEnd and the /doctor slash command can read it without
// threading a new field through `shared`'s type.
let stallWatchdog: ReturnType<typeof startStallWatchdog> | null = null;

export function syncModeModel(shared: any, mode: ModeConfig | undefined): void {
  if (!mode) return;
  if (!shared.modelExplicit) {
    if (mode.slug === "general") {
      const configuredModeModel = parseModelId(mode.model || GENERAL_MODEL_ID, shared.baselineProviderName);
      const modeModel = configuredModeModel &&
        (!shared.providerExplicit || shared.baselineProviderName === configuredModeModel.provider)
        ? configuredModeModel
        : undefined;
      if (modeModel) {
        shared.providerName = modeModel.provider;
        shared.activeModel = modeModel.model;
      }
    } else {
      shared.providerName = shared.baselineProviderName;
      shared.activeModel = shared.baselineModel;
    }
  }
  if (!shared.effortExplicit) {
    const preset = getPreset(shared.providerName);
    const caps = preset?.models[shared.activeModel ?? preset.defaultModel];
    shared.activeEffort = mode.slug === "general"
      ? (caps?.effort ? (mode.reasoningEffort || GENERAL_REASONING_EFFORT) : undefined)
      : (shared.baselineEffort || caps?.effort?.default);
  }
}

// Guarded so tests can import handleSlashCore (below) without triggering the
// real CLI startup (which reads real settings.json / calls process.exit on a
// non-TTY stdin).
//
// Compare REALPATHS, not raw URLs: `npm i -g` installs bin/nib as a
// symlink, so process.argv[1] is the symlink path while import.meta.url is
// already resolved to dist/cli.js. A raw comparison is false in exactly the
// case that matters and the installed CLI silently exits without running.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main();
}

/**
 * Pre-mount ask-tier TOFU confirmation for a project settings file that
 * declares execution-capable keys (config/settings-trust.ts). Runs as its
 * own short-lived Ink render — the main App hasn't mounted yet at this point
 * in startup (statusline/mcpServers/env.BASE_URL are all resolved before the
 * real render() call), so this asks the same question via a second, throwaway
 * Ink instance instead of deferring the ask past the point the answer is
 * needed. Resolves true = trust forever (persisted), false = skip this
 * session (caller strips the keys).
 */
async function promptSettingsTrust(
  keys: string[],
  settingsPath: string,
  status: "new" | "changed",
  themeConfig: { mode?: "dark" | "light" | "auto"; name?: string; overrides?: Record<string, unknown> },
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const handleResolve = (trusted: boolean) => {
      inkInstance.unmount();
      resolvePromise(trusted);
    };
    const inkInstance = render(
      <ThemeProvider config={themeConfig}>
        <SettingsTrustPrompt keys={keys} settingsPath={settingsPath} status={status} resolve={handleResolve} />
      </ThemeProvider>,
      { exitOnCtrlC: false },
    );
  });
}

/**
 * Pre-mount folder-level "fast path" confirmation (config/folder-trust.ts),
 * shown BEFORE the three existing per-artifact gates. Same throwaway-Ink-render
 * pattern as promptSettingsTrust, for the same reason: the main App hasn't
 * mounted yet at this point in startup.
 */
async function promptFolderTrust(
  projectDir: string,
  summary: import("./config/folder-trust.js").FolderContentSummary,
  status: "new" | "changed",
  themeConfig: { mode?: "dark" | "light" | "auto"; name?: string; overrides?: Record<string, unknown> },
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const handleResolve = (trusted: boolean) => {
      inkInstance.unmount();
      resolvePromise(trusted);
    };
    const inkInstance = render(
      <ThemeProvider config={themeConfig}>
        <FolderTrustPrompt projectDir={projectDir} summary={summary} status={status} resolve={handleResolve} />
      </ThemeProvider>,
      { exitOnCtrlC: false },
    );
  });
}

async function main() {
  initPresets();

  const rawArgs = process.argv.slice(2);
  if (rawArgs.length > 0 && rawArgs[0] === "doctor") {
    await runDoctor();
    process.exit(0);
  }

  if (process.argv[2] === "auth") {
    process.exit(await runAuth(process.argv.slice(3)));
  }

  if (process.argv[2] === "models") {
    process.exit(await runModels(process.argv.slice(3)));
  }

  const parsed = await parseArguments();
  if (parsed.version || parsed.help) process.exit(0);
  const additionalWriteRoots = resolveAdditionalDirs(parsed.addDirs, process.cwd());

  let configResult = loadConfig();
  if (configResult.errors.length > 0) {
    for (const e of configResult.errors) process.stderr.write(`Error: ${e}\n`);
    process.exit(1);
  }
  for (const w of configResult.warnings) process.stderr.write(`Warning: ${w}\n`);

  let initialPrompt = parsed.prompt;
  let resumeSessionId: string | true | undefined = parsed.resume;

  // Headless (-p) delegates entirely to runExecMode, which does its own
  // loadConfig + settings-trust check (exec-runner.ts) and fails closed with
  // a stderr warning — same posture as untrusted project hooks/skills
  // headless. Nothing execution-capable (statusline/mcpServers/notify/
  // env.BASE_URL) is read or connected from THIS loadConfig call for the
  // headless path; it exists here only for the earlier error/warning surface.
  if (parsed.print) {
    process.exitCode = await runExecMode({
      prompt: parsed.prompt!,
      projectRoot: process.cwd(),
      resumeSessionId: typeof parsed.resume === "string" ? parsed.resume : undefined,
      mode: parsed.mode,
      model: parsed.model,
      debug: parsed.debug,
      additionalWriteRoots,
      maxTurns: parsed.maxTurns,
      allowedTools: parsed.allowedTools,
      disallowedTools: parsed.disallowedTools,
    });
    return;
  }

  if (!process.stdin.isTTY) {
    process.stderr.write("nib requires an interactive terminal (TTY). Re-run from a real terminal session.\n");
    process.exit(1);
  }

  // Folder-level "fast path" trust (config/folder-trust.ts): runs BEFORE the
  // three per-artifact gates below. A "yes" bulk-applies to the skill/
  // settings/hooks trust stores for exactly what's present right now, so none
  // of the three gates below prompt for it; a "no" (or nothing gated at all)
  // falls through to exactly today's per-artifact behavior. The theme config
  // isn't resolved yet at this point (it comes from configResult.config,
  // which is what's being asked about), so this uses the same default the
  // pre-mount settings prompt falls back to before that value exists.
  const projectDirForTrust = process.cwd();
  const folderSummary = buildFolderContentSummary(projectDirForTrust, configResult);
  if (hasGatedContent(folderSummary)) {
    const folderTrust = checkFolderTrust(projectDirForTrust, folderSummary);
    if (folderTrust.status !== "trusted") {
      const trusted = await promptFolderTrust(
        projectDirForTrust,
        folderSummary,
        folderTrust.status,
        { mode: configResult.config.theme?.mode, name: configResult.config.theme?.name, overrides: configResult.config.theme?.overrides },
      );
      if (trusted) {
        trustFolder(projectDirForTrust, folderSummary);
      }
      // "no" falls through — the three gates below run their normal
      // per-artifact prompts/strip/skip logic, completely unaware this ask
      // ever happened.
    }
  }

  // Execution-capable project settings (statusline/mcpServers/notify/
  // env.BASE_URL) require explicit trust before they take effect (TOFU, same
  // gate as hooks/skills). The main App hasn't mounted yet, so the ask uses a
  // short-lived standalone Ink render (promptSettingsTrust) rather than
  // deferring past the point these values are captured below. A "no" strips
  // the keys from the effective config for the rest of this session.
  if (configResult.projectExecutionKeys.length > 0) {
    const projectSettingsFile = projectSettingsPath(process.cwd());
    const trust = checkSettingsTrust(projectSettingsFile);
    if (trust.status !== "trusted") {
      const trusted = await promptSettingsTrust(
        configResult.projectExecutionKeys,
        projectSettingsFile,
        trust.status,
        { mode: configResult.config.theme?.mode, name: configResult.config.theme?.name, overrides: configResult.config.theme?.overrides },
      );
      if (trusted) {
        trustSettings(projectSettingsFile);
      } else {
        configResult = {
          ...configResult,
          config: stripExecutionKeys(configResult.config, configResult.projectExecutionKeys),
        };
      }
    }
  }

  const configEnv = configResult.config.env;
  const sessionTemp = createSessionTempDir();
  setSessionTempDir(sessionTemp.path);

  const resolvedApiKey = configEnv?.API_KEY || undefined;
  const resolvedBaseUrl = configEnv?.BASE_URL || undefined;

  const detected = detectProvider(configEnv);
  let providerName = configResult.config.provider || detected || "deepseek";
  const rawInitialModel = parsed.model ?? configResult.config.model ?? configEnv?.MODEL ?? undefined;
  const parsedInitialModel = parseModelId(rawInitialModel, providerName);
  // `--model` and settings.model are provider/model references. Resolve the
  // provider prefix before constructing the provider factory; a bare model
  // remains relative to the configured/detected provider for compatibility.
  if (rawInitialModel?.includes("/") && parsedInitialModel) {
    providerName = parsedInitialModel.provider;
  }
  // Captured for getProvider() below: the resolved API key/base URL come from
  // settings.json env.* and are only valid for THIS provider. Reusing them
  // after /model switches to a different provider would leak one provider's
  // credentials/host to another.
  const startupProviderName = providerName;

  if (!detected && !configResult.config.provider && !resolvedApiKey) {
    const hasCreds = Object.values(readCredentialsFile()).some((v) => v);
    if (!hasCreds) {
      console.log("No API keys found. Set config.env.API_KEY, env var, or run `nib auth`.");
      if (!parsed.prompt) process.exit(0);
    }
  }

  const initialModel: string | undefined = parsedInitialModel?.model;
  const thinkingEnabled = configResult.config.thinkingEnabled ?? true;
  const reasoningEffort = configResult.config.reasoningEffort;

  function getActiveModelCaps(): ModelCapabilities | undefined {
    const preset = getPreset(shared.providerName);
    if (!preset) return undefined;
    return preset.models[shared.activeModel ?? preset.defaultModel];
  }

  function getProvider(modelId?: string) {
    // An optional "provider/model" id (a defined agent's model override, §F4)
    // creates a provider bound to that model instead of the session's.
    const slash = modelId ? modelId.indexOf("/") : -1;
    const overrideProvider = slash > 0 ? modelId!.slice(0, slash) : undefined;
    const overrideModel = slash > 0 ? modelId!.slice(slash + 1) : undefined;
    const provName = overrideProvider ?? shared.providerName;
    // The startup env.API_KEY/env.BASE_URL are scoped to the provider active at
    // startup. Once /model switches to a different provider (or a sub-agent
    // spawns on another provider), a key/host meant for the old provider must
    // not leak to the new one — fall through to that provider's own
    // keyEnv/getCredential resolution instead.
    const isStartupProvider = provName === startupProviderName;
    return createProvider(provName, {
      modelOverride: overrideModel ?? shared.activeModel,
      baseUrl: isStartupProvider ? resolvedBaseUrl : undefined,
      apiKey: isStartupProvider ? resolvedApiKey : undefined,
    });
  }

  const modeLoader = new ModeLoader();
  const permissions = new PermissionEngine(
    configResult.config.permissions,
    process.cwd(),
    Object.keys(configResult.config.mcpServers ?? {}).length > 0,
    {
      // docs/unified-write-boundary.md §2: the file-tool write boundary is
      // active whenever the profile level is workspace-write (unconditional
      // — not gated on sandbox.enabled). The engine resolves in-set writes
      // silently and out-of-set writes to a guarded ask, from the same
      // resolveWriteRoots set the Seatbelt layer emits allow-lines from,
      // including explicit --add-dir roots for this session.
      enforceWriteBoundary: configResult.config.permissionProfile?.level === "workspace-write",
      writePolicyLevel: configResult.config.permissionProfile?.level,
      sessionTempDir: sessionTemp.path,
      writeRoots: [...(configResult.config.sandbox?.writeRoots ?? []), ...additionalWriteRoots],
      // Re-record the TOFU trust hash after every persisted "always"
      // approval — persist() rewrites this project's settings.json, and
      // without this the trust store's hash goes stale and the next launch
      // classifies the file as tampered (config/settings-trust.ts).
      onPersist: (settingsPath) => trustSettings(settingsPath),
    },
  );
  // The capability-boundary gate (permission-profile.md §3): loadConfig
  // supplies workspace-write by default; an explicit unrestricted profile is
  // still represented here so the evaluator can honor that opt-out.
  const permissionProfile = new ProfileEvaluator(configResult.config.permissionProfile!, process.cwd(), {
    writeRoots: [...(configResult.config.sandbox?.writeRoots ?? []), ...additionalWriteRoots],
    sessionTempDir: sessionTemp.path,
  });

  // Orchestrator mode (9.3) is registered once at startup, but its runtime
  // dependencies only exist inside main(): the provider factory resolves per
  // spawn so sub-agents follow /model switches, and the permission engine is
  // the live session one so sub-agents inherit the parent's rules + approval
  // posture and cannot escalate (24.3). askUser is re-pointed per turn by
  // runAgentTurnCore — the prompt bridge is recreated each turn.
  // Lifecycle hooks (docs/hooks-spec.md): constructed once per session and
  // threaded into the agent loop, the orchestrator, the App, and the notify
  // completion boundaries. A no-op when no hooks are configured (opt-in).
  const hooks = new HookRunner({
    config: configResult.config.hooks,
    disableAllHooks: configResult.config.disableAllHooks,
    debug: parsed.debug,
    cwd: process.cwd(),
    sessionId: () => sessionId,
    getPermissionMode: () => shared.posture,
    sandboxLevel:
      configResult.config.sandbox?.enabled && configResult.config.permissionProfile?.level !== "unrestricted"
        ? configResult.config.permissionProfile?.level
        : undefined,
    writeRoots: [...(configResult.config.sandbox?.writeRoots ?? []), ...additionalWriteRoots],
    sessionTempDir: sessionTemp.path,
  });
  // Startup trust check (spec §6): headless skips unseen project hooks with a
  // stderr warning; interactive runs defer the ask to first dispatch.
  hooks.verifyTrust();

  // Agent definitions (feature-plans.md §F4): loaded once at startup — project
  // `.nib/agents/` wins over global, like modes — indexed into the stable
  // preamble, and resolved by new_task's `agent` parameter at spawn time.
  const agentLoader = new AgentLoader();
  const agents = await agentLoader.load(process.cwd());

  // Custom slash commands (`.nib/commands/*.md`): loaded once at startup,
  // project > global like agents/modes, and threaded to App for routing + Tab
  // completion. They are pure prompt templates — no execution side effects — so
  // they need no TOFU trust gate (the prompt they inject is the user's own file).
  const commandLoader = new CommandLoader();
  const commands: CommandDef[] = await commandLoader.load(process.cwd());

  const orchestrator = new Orchestrator({
    provider: getProvider,
    registry,
    modeLoader,
    agents: agentLoader,
    permissions,
    // Sub-agents inherit the parent's profile together with the rule engine
    // (permission-profile.md §6) — same object threading as today.
    profile: permissionProfile,
    getSignal: () => shared.abort.signal,
    hooks,
  });
  orchestrator.register(registry);

  // Async sub-run live text (async-subagents.md §4): the App registers its
  // mount-time streaming sink here; runAgentTurnCore routes every progress
  // event through BOTH it and the per-turn callback, so streamed sub-run text
  // renders regardless of turn state (the parent turn has ended while sub-runs
  // work).
  let appSubagentSink: ((event: SubagentProgress) => void) | undefined;

  let _compactor: Compactor | undefined;
  function getCompactor(): Compactor {
    if (!_compactor) {
      const contextWindow = configResult.config.contextWindow ?? getActiveModelCaps()?.contextWindow ?? 128000;
      _compactor = new Compactor(getProvider(), contextWindow, configResult.config.compaction?.threshold, configResult.config.compaction?.auto ?? true);
    }
    return _compactor;
  }
  // _compactor memoizes the provider captured at first use — after /model
  // switches providers it must be dropped so the next getCompactor() rebuilds
  // against the new provider instead of silently keeping the old one.
  function resetCompactor(): void {
    _compactor = undefined;
  }

  const sessionStore = new SessionStore(resolveHome(), configResult.config.retention);
  let sessionId: string;
  let sessionMessages: Message[] = [];
  let sessionLoaded = false;

  const sessionCreateBase = {
    cwd: process.cwd(),
    provider: providerName,
    model: initialModel || ((parsed.mode === "general" || !parsed.mode) &&
      (!configResult.config.provider || configResult.config.provider === "deepseek") &&
      (!detected || detected === "deepseek")
      ? "deepseek-v4-flash"
      : getPreset(providerName)?.defaultModel || "deepseek-v4-pro"),
    mode: parsed.mode || "general",
    modelExplicit: rawInitialModel !== undefined,
    effortExplicit: reasoningEffort !== undefined,
    ...(reasoningEffort !== undefined ? { effort: reasoningEffort } : {}),
  };

  // loadEffective replays `state` records into meta, so a session resumed after
  // a /model switch carries the provider/model that was active when it ended.
  // Adopt it unless the user overrode the choice explicitly on this launch
  // (CLI flag / settings.json), which must still win. Mode follows the same
  // rule (resumedMode below): a resumed session's last mode wins over the
  // general default, but an explicit --mode on this launch still wins over both.
  let resumedProvider: string | undefined;
  let resumedModel: string | undefined;
  let resumedMode: string | undefined;
  let resumedModelExplicit: boolean | undefined;
  let resumedEffort: string | undefined;
  let resumedEffortExplicit: boolean | undefined;

  if (typeof resumeSessionId === "string") {
    try {
      const loaded = await sessionStore.loadEffective(resumeSessionId);
      sessionId = resumeSessionId;
      sessionMessages = loaded.messages;
      sessionLoaded = true;
      resumedProvider = loaded.meta?.provider;
      resumedModel = loaded.meta?.model;
      resumedMode = loaded.meta?.mode;
      resumedModelExplicit = loaded.meta?.modelExplicit;
      resumedEffort = loaded.meta?.effort;
      resumedEffortExplicit = loaded.meta?.effortExplicit;
    } catch {
      process.stderr.write(`Session not found: ${resumeSessionId}\n`);
      process.exit(1);
    }
  } else if (parsed.continueLast) {
    const sessions = await sessionStore.list();
    if (sessions.length > 0) {
      sessionId = sessions[0].id;
      try {
        const loaded = await sessionStore.loadEffective(sessionId);
        sessionMessages = loaded.messages;
        sessionLoaded = true;
        resumedProvider = loaded.meta?.provider;
        resumedModel = loaded.meta?.model;
        resumedMode = loaded.meta?.mode;
        resumedModelExplicit = loaded.meta?.modelExplicit;
        resumedEffort = loaded.meta?.effort;
        resumedEffortExplicit = loaded.meta?.effortExplicit;
      } catch (err) {
        process.stderr.write(`Failed to load session ${sessionId}: ${(err as Error).message}\n`);
        process.exit(1);
      }
    } else {
      sessionId = await sessionStore.create(sessionCreateBase);
    }
  } else {
    sessionId = await sessionStore.create(sessionCreateBase);
  }

  // Retention runs after selecting/creating the current session so the active
  // transcript is never evicted by an age or count limit.
  await sessionStore.pruneRetention(sessionId);

  // --name names a freshly-created session; a resume/continue keeps the session's
  // own (possibly renamed) title untouched. The index title survives the first
  // message's derived-title update (sessions/store.ts updateIndexEntry).
  if (parsed.name && !sessionLoaded) {
    await sessionStore.renameSession(sessionId, parsed.name);
  }

  const resumedModelSelection = resolveRestoredSelection(resumedModel, resumedModelExplicit);
  const resumedEffortSelection = resolveRestoredSelection(resumedEffort, resumedEffortExplicit);

  if (parsed.debug) enableDebug(sessionId);

  let checkpoints = new CheckpointManager(sessionId, undefined, undefined, {
    maxBytes: configResult.config.retention?.maxCheckpointBytes,
  });
  const diagnostics = new DiagnosticRunner();
  // Layered failure handling, constructed once per session so the reflector's
  // total-retry budget spans the whole conversation. Both engage only on error
  // paths inside runAgent (failed tool result / malformed tool JSON / fatal
  // turn exception), so the happy path pays nothing but a per-turn counter reset.
  const errorReflector = new ErrorReflector();
  const errorRecovery = new ErrorRecovery();
  setSessionId(sessionId);
  setCheckpointManager(checkpoints);
  setSessionStore(sessionStore);
  // switch_mode tool → same path /mode uses: load → set activeMode →
  // persist state. Fresh object identity every switch keeps the stable
  // preamble cache honest (getStablePreamble compares mode by identity).
  setSetMode(async (slug: string) => {
    const mode = await modeLoader.load(slug);
    if (!mode) return null;
    shared.activeMode = { ...mode };
    syncModeModel(shared, shared.activeMode);
    await sessionStore.appendState(sessionId, { mode: slug });
    return mode.name;
  });

  // commands.timeoutToBackground (plan §3, decision D — default ON): run_bash
  // timeout → background migration for the model-facing tool set.
  setTimeoutToBackground(configResult.config.commands?.timeoutToBackground ?? true);

  // sandbox (permission-profile.md §8, phase (e)): when the flag is on and
  // the profile level demands it, bash children spawn under a Seatbelt
  // profile. macOS-only — the loader warned at startup if this is a no-op.
  setSandboxLevel(
    configResult.config.sandbox?.enabled &&
    configResult.config.permissionProfile &&
    configResult.config.permissionProfile.level !== "unrestricted"
      ? configResult.config.permissionProfile.level
      : undefined,
  );
  setWritePolicyLevel(permissionProfile.level);
  // sandbox.writeRoots (docs/unified-write-boundary.md) plus explicit
  // --add-dir roots. The loader keeps project config global-only; CLI roots
  // are session-scoped and already resolved from startup cwd. Threaded into
  // ctx so Seatbelt and file-tool containment consult the same set.
  setWriteRoots([...(configResult.config.sandbox?.writeRoots ?? []), ...additionalWriteRoots]);

  const notifySpawnOptions: NotifySpawnOptions = {
    cwd: process.cwd(),
    trustedRoot: process.cwd(),
    sandboxLevel:
      configResult.config.sandbox?.enabled && configResult.config.permissionProfile?.level !== "unrestricted"
        ? configResult.config.permissionProfile?.level
        : undefined,
    writeRoots: [...(configResult.config.sandbox?.writeRoots ?? []), ...additionalWriteRoots],
    sessionTempDir: sessionTemp.path,
  };

  // Local stdio MCP servers inherit the session's child-process containment.
  // HTTP MCP helpers do not pass through this connector and remain unchanged.
  if (configResult.config.mcpServers) {
    await connectMCPServers(configResult.config.mcpServers, {
      strictMcpConfig: configResult.config.strictMcpConfig,
      spawn: {
        cwd: process.cwd(),
        trustedRoot: process.cwd(),
        sandboxLevel:
          configResult.config.sandbox?.enabled && configResult.config.permissionProfile?.level !== "unrestricted"
            ? configResult.config.permissionProfile?.level
            : undefined,
        writeRoots: [...(configResult.config.sandbox?.writeRoots ?? []), ...additionalWriteRoots],
        sessionTempDir: sessionTemp.path,
      },
    });
    process.on("exit", () => disconnectAllMCPServers());
  }

  // web_search backend config (webSearch.searxngUrl): configResult was
  // reassigned above (the TOFU strip on decline) if the project declared any
  // execution-capable keys, so this read already sees the stripped value.
  // web-search.ts reads this via ToolContext instead of calling loadConfig()
  // itself, which would bypass the gate.
  setWebSearchConfig(configResult.config.webSearch);

  // Background-job completion → notify hook (plan §3): a job finishing is a
  // completion boundary like a turn ending, so the same notify script fires
  // with a job payload (STATUS=job_done — notify-spec.md §3-4). The TUI status
  // segment for the same event is rendered by App, which subscribes to
  // JobManager directly. Fire-and-forget — see src/notify.ts.
  jobManager.onCompleted((report) => {
    const jobNotifyInput = {
      status: "job_done" as const,
      durationMs: report.runningMs,
      body: (report.stdout + report.stderr).slice(-2000),
      title: report.command,
      job: { id: report.id, command: report.command, exitCode: report.exitCode },
    };
    fireNotify(
      configResult.config.notify,
      jobNotifyInput,
      { debug: parsed.debug, spawn: notifySpawnOptions },
    );
    // Notification hooks fire alongside the notify script — never instead of
    // it (hooks-spec.md §7).
    fireNotificationHooks(hooks, jobNotifyInput);
  });

  const memoryStore = new MemoryStore();
  await memoryStore.init();
  const memoryInjection = await memoryStore.getInjection();

  // Repository map: computed once per session (symbol extraction + ranking is
  // ~150ms cold on this repo, negligible for startup) and injected into the
  // stable preamble as a byte-stable snapshot. buildRepoMap never throws — a
  // failure degrades to `undefined`, i.e. no map, never a startup crash.
  const repomapInjection = (await buildRepoMap(process.cwd())) ?? undefined;

  // Dirty-file baseline: captured once before any agent edits so the per-turn
  // environment block can tag each file "pre-existing" vs "this session"
  // (see PromptContext.dirtyBaseline). Never throws — a failure degrades to
  // "", i.e. no baseline and no tags, never a startup crash.
  const dirtyBaseline = await captureGitStatus(process.cwd());

  const shared = {
    conversationHistory: [] as Message[],
    sessionInput: 0,
    sessionOutput: 0,
    lastContextTokens: 0,
    sessionUserInputs: [] as string[],
    abort: new AbortController(),
    toolUsage: {} as Record<string, number>,
    modelUsage: {} as Record<string, { input: number; output: number; cached: number }>,
    posture: "normal" as "normal" | "autoApprove" | "plan",
    // An explicit choice this launch (--model / settings.json) outranks the
    // resumed session's last-used provider/model; otherwise resume restores it.
    providerName: (configResult.config.provider || rawInitialModel ? providerName : resumedProvider) ?? providerName,
    activeModel: (initialModel ?? resumedModelSelection.value) as string | undefined,
    activeEffort: undefined as string | undefined,
    modelExplicit: (rawInitialModel !== undefined || resumedModelSelection.explicit) as boolean,
    effortExplicit: (reasoningEffort !== undefined || resumedEffortSelection.explicit) as boolean,
    providerExplicit: (configResult.config.provider !== undefined || detected !== undefined) as boolean,
    baselineProviderName: ((configResult.config.provider || rawInitialModel ? providerName : resumedProvider) ?? providerName) as string,
    baselineModel: (initialModel ?? resumedModelSelection.value) as string | undefined,
    baselineEffort: (reasoningEffort ?? resumedEffortSelection.value) as string | undefined,
    // Live mode: /mode and the /modes picker mutate this so the running agent
    // (runAgentTurnBridge reads shared.activeMode) picks up the switch mid-
    // session. A plain closure var here would stay stale until restart.
    // Resolved just below — never left undefined — so "no mode selected" can
    // no longer fall through to registry.getAllDefs() (every tool, ungated).
    activeMode: undefined as ModeConfig | undefined,
    debug: parsed.debug as boolean | undefined,
    // CLI tool-set + turn caps (flag parity): read by runAgentTurnBridge so a
    // launched session honours them without threading new params through the
    // App bridge.
    maxTurns: parsed.maxTurns as number | undefined,
    allowedTools: parsed.allowedTools as string[],
    disallowedTools: parsed.disallowedTools as string[],
  };
  shared.activeEffort = shared.effortExplicit
    ? (reasoningEffort ?? resumedEffortSelection.value)
    : getActiveModelCaps()?.effort?.default;

  // Startup mode resolution: an explicit --mode on this launch wins (handled
  // below, after this block, same as today); otherwise a resumed session's
  // last mode wins; otherwise general — the same "everything but write access"
  // persona sessionCreateBase.mode already defaults new sessions to.
  if (!parsed.mode) {
    shared.activeMode = (await modeLoader.load(resumedMode || "general")) ?? (await modeLoader.load("general")) ?? undefined;
  }

  syncModeModel(shared, shared.activeMode);

  // A session resumed at startup (--resume/--continue) must seed the live history so
  // the model actually sees the prior turns on the very first message. Without
  // this, runAgentTurnBridge gets `history: undefined` and the resume is
  // context-blind (the interactive /resume path does this via resumeSession()).
  if (sessionLoaded) {
    shared.conversationHistory = sessionMessages;
  }

  async function logSessionEnd() {
    try {
      const compactor = getCompactor();
      const { summary, files } = compactor.getLastCompaction();
      const decisions = extractDecisions(summary);
      if (shared.sessionUserInputs.length > 0 || files.length > 0 || summary) {
        await memoryStore.appendSession({
          date: new Date().toISOString().slice(0, 10),
          tasks: [...shared.sessionUserInputs],
          decisions, files, summary: summary ?? undefined,
        });
      }
    } catch {}
    if (stallWatchdog) {
      try {
        const report = await stallWatchdog.stop();
        stallWatchdog = null;
        return `[profile] ${report.count} stalls ≥150ms (worst ${report.worstLagMs}ms) — ${report.profilePath ?? "lateness-only, no profile"}`;
      } catch {}
      stallWatchdog = null;
    }
    return null;
  }

  const skillLoader = new SkillLoader();
  let skills = await skillLoader.load({ headless: !!parsed.print, enabledSkills: configResult.config.enabledSkills });
  const { def: loadSkillDef, handler: loadSkillHandler } = createLoadSkillTool(skills);
  registry.register({ def: loadSkillDef, handler: loadSkillHandler, groups: ["read"], always: true });

  if (parsed.mode) {
    const mode = await modeLoader.load(parsed.mode);
    if (mode) { shared.activeMode = mode; syncModeModel(shared, shared.activeMode); await sessionStore.appendState(sessionId, { mode: parsed.mode }); }
  }

  // Shown inside the app's scrollback after mount — printing to stdout here
  // would get garbled by Ink's first render.
  const resumeNotice = sessionLoaded
    ? `Resumed ${sessionId} · ${sessionMessages.length} messages · mode: ${shared.activeMode?.slug || "general"}`
    : undefined;
  const initialNotice = [...skillLoader.notices, containmentWarning(configResult.config), workspaceOutsideHomeWarning(configResult.config, process.cwd()), resumeNotice].filter(Boolean).join("\n") || undefined;

  let knownModeSlugs: string[] = [];
  try { knownModeSlugs = (await modeLoader.listAll()).map(m => m.slug); } catch {}

  function buildStatusBar(): import("./ui/types.js").StatusSegment[] {
    const T = (id: string, text: string, props?: Partial<import("./ui/types.js").StatusSegment>): import("./ui/types.js").StatusSegment => ({ id, text, ...props });
    const dim = (id: string, text: string) => T(id, text, { dimColor: true });
    const segments: import("./ui/types.js").StatusSegment[] = [];
    let idCounter = 0;
    const nextId = () => `s${++idCounter}`;

    // Leading identity: the active mode (green dot) and the permission posture
    // (warning/info dot) are independent switches — a persona and a permission
    // scope answer different questions, so showing one must not hide the other.
    // (Before, posture replaced mode, so switching to plan/auto-approve made a
    // set /mode look like it had been dropped.) "normal" is the fallback
    // identity only when neither is set.
    // A coloured dot carries the state and the word stays neutral, so the row
    // has one accent per meaning rather than three competing coloured words.
    const statusDot = (code: number) =>
      colorEnabled ? `${ansiFg(code)}●${ANSI_RESET} ` : "* ";
    if (shared.activeMode?.name) {
      segments.push(T(nextId(), `${statusDot(resolvedTheme.theme.success)}${shared.activeMode.name}`, { raw: true }));
    }
    if (shared.posture === "autoApprove") {
      // Spelled out, not abbreviated. This is the highest-consequence state the
      // bar reports — tools run without asking — so it must be readable at a
      // glance by someone who has never read the docs. The old short form
      // ("aa") was the least legible label on the row while naming the most
      // dangerous state, and the hint bar does NOT spell it out as once
      // assumed: it shows the *action* (⇧ Tab → normal), not the current state.
      segments.push(T(nextId(), `${statusDot(resolvedTheme.theme.warning)}auto-approve`, { raw: true }));
    } else if (shared.posture === "plan") {
      segments.push(T(nextId(), `${statusDot(resolvedTheme.theme.info)}plan`, { raw: true }));
    } else if (!shared.activeMode?.name) {
      segments.push(T(nextId(), `${statusDot(resolvedTheme.theme.success)}normal`, { raw: true }));
    }

    // The permission profile level is NOT in the bar: it is static config
    // (set once in settings), not ambient session state — the bar shows what
    // changes mid-session (mode, posture, effort, context fill). The level is
    // visible in `nib doctor` and /permissions (decided 2026-08-14).

    // The model is NOT here — it rides as a chip on the input box's right edge
    // (see buildModelPill), because it is a property of the message you are
    // about to send rather than ambient session state.

    // Thinking mode, labelled the same way the welcome screen labels it
    // ("thinking high" / "thinking on" / "thinking off") so the two agree — a
    // bare "high" in the bar did not say what was high. Plain dim text rather
    // than a filled chip: this is a preference you set and forget, and as an
    // orange slab it was the loudest thing on a row where it is the least
    // urgent. The orange is now spent on auto-approve and a full context.
    // Shown only when the model declares effort levels.
    if (thinkingEnabled && getActiveModelCaps()?.effort) {
      segments.push(dim(nextId(), `thinking ${shared.activeEffort ?? "on"}`));
    }

    const ctxPercent = getContextPercent();
    if (ctxPercent !== null) {
      // A thin meter rather than block glyphs: context usage is ambient, and
      // heavy blocks made it the loudest thing on the row.
      const bar = meter(ctxPercent, 12, {
        fg: ctxPercent >= 95
          ? resolvedTheme.theme.error
          : ctxPercent >= 80
            ? resolvedTheme.theme.warning
            : resolvedTheme.theme.textDim,
        dim: resolvedTheme.theme.surface,
        colorEnabled,
      });
      segments.push(T(nextId(), `ctx ${bar} ${Math.round(ctxPercent)}%`, { raw: true, dimColor: true }));
    }

    // Session cost: ambient like context fill, not an alarm — dim treatment,
    // no color thresholds. Hidden until spend is nonzero (getCostStr already
    // guards this) so a fresh session doesn't show "$0.0000". Gated behind
    // settings showCost (default false — owner asked to hide it 2026-08-14;
    // the estimate machinery stays for when the flag is on).
    const costStr = configResult.config.showCost ? getCostStr() : null;
    if (costStr !== null) {
      segments.push(dim(nextId(), `$${costStr}`));
    }

    // Async sub-runs (async-subagents.md §4): while any task runs, the bar
    // reports it (`● task <id> running`, or `N tasks` when several) — the
    // parent turn has ended, so this is the row's only live "still working"
    // signal. Derived from the live registry snapshot, so the segment appears
    // and clears with registry state.
    segments.push(...buildTaskSegments(orchestrator.tasks.list()));

    return segments;
  }

  /**
   * The model chip shown on the input box's right edge. Pre-rendered ANSI (not
   * a node) so it stays inside the single input row — see PromptInput.modelPill.
   */
  /**
   * The active model's display name, with the same fallback the status bar
   * uses. `shared.activeModel` is undefined until a model is explicitly
   * chosen, so reading it directly renders "unknown" on a fresh session even
   * though the provider's default is what will actually be used.
   */
  function modelDisplayName(): string {
    const modelId = shared.activeModel ?? getPreset(shared.providerName)?.defaultModel ?? "unknown";
    return getActiveModelCaps()?.displayName ?? modelId;
  }

  function buildModelPill(): string {
    return chip(modelDisplayName(), {
      fg: resolvedTheme.theme.textBright,
      bg: resolvedTheme.theme.border,
      colorEnabled,
    });
  }

  // Tool schemas + repo map ride on every request but are absent from
  // conversationHistory, so measuring history alone under-reads context fill by
  // most of the payload on a tool-heavy session. Mirrors the tool set
  // runAgentTurnBridge builds for the active mode; the repo map stands in for
  // the volatile prefix, which runAgent rebuilds per turn and is not reachable
  // here. Shared by the status bar meter and /context.
  function getOverheadTokens(): number {
    const tools = shared.activeMode?.groups
      ? registry.getByMode(shared.activeMode.groups)
      : registry.getAllDefs();
    return estimateOverheadTokens(tools, repomapInjection);
  }

  function getContextPercent(): number | null {
    const preset = getPreset(shared.providerName);
    const caps = preset?.models[shared.activeModel ?? preset.defaultModel];
    if (!caps?.contextWindow) return null;
    // Use estimateTokens on the live conversation history, not the API's
    // per-call usage report. lastContextTokens tracked the last single-call
    // input+output, which fluctuates across turns and never reflects the
    // total context fill level. The /context command uses the same estimator.
    // Overhead is added so the meter reflects the whole request, matching what
    // the compaction check measures. It is also why the meter is visible from
    // startup instead of appearing only after the first turn: the tools and repo
    // map are already on the wire before any message exists.
    const total = estimateTokens(shared.conversationHistory) + getOverheadTokens();
    if (total === 0) return null;
    return (total / caps.contextWindow) * 100;
  }

  function getCostStr(): string | null {
    const preset = getPreset(shared.providerName);
    const caps = preset?.models[shared.activeModel ?? preset.defaultModel];
    if (!caps?.pricing) return null;
    if (shared.sessionInput === 0 && shared.sessionOutput === 0) return null;
    return ((shared.sessionInput * caps.pricing.inputPerM + shared.sessionOutput * caps.pricing.outputPerM) / 1_000_000).toFixed(4);
  }

  const colorEnabled = !!process.stdout.isTTY && !process.env.NO_COLOR;

  const resolvedTheme = new ThemeContextValue(resolveTheme({ mode: configResult.config.theme?.mode ?? "dark", name: configResult.config.theme?.name, overrides: configResult.config.theme?.overrides }));

  let resolvedKeybindings: KeybindingMap | undefined;
  let resolvedKeybindingConfig: KeybindingSystemConfig | undefined;
  const rawKbConfig = configResult.config.keybindings;
  if (rawKbConfig && "overrides" in rawKbConfig) {
    const ext = rawKbConfig as any;
    const overrides: Record<string, any> = {};
    if (ext.overrides) {
      for (const [action, value] of Object.entries(ext.overrides)) {
        if (typeof value === "string") { const combo = parseKeyCombo(value); if (combo) overrides[action] = [combo]; }
        else if (Array.isArray(value)) { overrides[action] = value.map((v: string) => parseKeyCombo(v)).filter(Boolean); }
      }
    }
    resolvedKeybindingConfig = { overrides, disabled: ext.disabled };
  } else if (rawKbConfig && typeof rawKbConfig === "object") {
    resolvedKeybindingConfig = rawKbConfig as KeybindingSystemConfig;
  }
  resolvedKeybindings = resolveKeybindings(resolvedKeybindingConfig);

  const workflowConfig: WorkflowIntegrationConfig = {
    gitStatus: configResult.config.workflow?.gitStatus ?? true,
    gitPollInterval: configResult.config.workflow?.gitPollInterval ?? 30000,
    gitCommands: configResult.config.workflow?.gitCommands ?? true,
    detectBuildTools: configResult.config.workflow?.detectBuildTools ?? true,
  };

  // Config-driven status line providers (command/module). Built from settings;
  // App subscribes and starts/stops the async refresh loop.
  const statuslineConfig = configResult.config.statusline;
  const statusLineManager = statuslineConfig
    ? new StatusLineManager(statuslineConfig, {
      spawn: {
        trustedRoot: process.cwd(),
        sandboxLevel:
          configResult.config.sandbox?.enabled && configResult.config.permissionProfile?.level !== "unrestricted"
            ? configResult.config.permissionProfile?.level
            : undefined,
        writeRoots: [...(configResult.config.sandbox?.writeRoots ?? []), ...additionalWriteRoots],
        sessionTempDir: sessionTemp.path,
      },
    })
    : undefined;

  const restartRef: { current: (() => void) | null } = { current: null };

  function startApp(): void {
    let restarting = false;
    const appInitialPrompt = initialPrompt;
    initialPrompt = undefined;
    const showResumeChooserOnStart = resumeSessionId === true;
    resumeSessionId = undefined;

    const appCtx = {
      mutable: shared,
      autoApproveAllowed: hasActiveSandboxContainment(configResult.config),
      getProvider,
      sessionId,
      permissions,
      permissionProfile,
      hooks,
      toolRegistry: registry,
      compactor: getCompactor(),
      diagnostics,
      skills,
      commands,
      memoryInjection: memoryInjection ?? undefined,
      memoryStore,
      sessionStore,
      checkpoints,
      modeLoader,
      skillLoader,
      get providerName() { return shared.providerName; },
      get activeModel() { return shared.activeModel; },
      get activeMode() { return shared.activeMode; },
      get activeEffort() { return shared.activeEffort; },
      effortValues: () => getActiveModelCaps()?.effort?.values ?? [],
      provideAbortController: () => shared.abort,
      renewAbortController: () => { shared.abort = new AbortController(); },
      completer: (line: string) => completer(line, knownModeSlugs, commands.map((c) => c.name)),
      buildStatusBar,
      buildModelPill,
      modelDisplayName,
      statusLineManager,
      getPromptStr: () => (colorEnabled ? `\u001B[34m\u258C\u001B[0m \u001B[34m\u203A\u001B[0m ` : "nib > "),
      getColorEnabled: () => colorEnabled,
      logSessionEnd,
      onExit: () => logSessionEnd().catch(() => null).then((line) => { if (line) process.stderr.write(line + "\n"); process.exit(0); }),
      handleSlash: async (input: string) => {
        const lines: string[] = [];
        const origLog = console.log;
        console.log = (...args) => lines.push(args.map(String).join(" "));
        try { await handleSlashCore(input, getProvider, configResult, modeLoader, permissions, sessionStore, sessionId, checkpoints, memoryStore, memoryInjection, getCompactor, diagnostics, skills, skillLoader, shared, getActiveModelCaps, getCostStr, colorEnabled, reasoningEffort, resetCompactor, getOverheadTokens, agents); } finally { console.log = origLog; }
        return lines;
      },
      getModelEntries: () => listKnownModels(),
      getConfiguredProviders: () => getConfiguredProviders(),
      getProviderLabels: () => getProviderLabels(),
      getKeyEnvByProvider: () => getKeyEnvByProvider(),
      getFavoriteModels: () => loadFavoriteModels(),
      toggleFavoriteModel: (id: string) => persistToggleFavorite(id),
      getRecentModels: () => loadRecentModels(),
      saveProviderKey: async (provider: string, key: string) => {
        try {
          const preset = getPreset(provider);
          if (!preset?.keyEnv) {
            return { ok: false, error: `Provider "${provider}" has no configurable API key.` };
          }
          await authSaveKey(provider, key, /* silent */ true);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },
      runAgentTurnCore: (input: string, cb: any, imageUrls?: string[], planMode?: boolean) => {
        // Sub-agents spawned by the orchestrator must see this turn's ask
        // prompt (19.1). cb.askUser is a fresh bridge per turn, so re-point
        // the orchestrator before delegating — otherwise sub-agents holding
        // the stale closure would auto-deny every ask-tier action.
        orchestrator.setAskUser(cb.askUser);
        // Same per-turn re-point reason as askUser: the callback bundle is
        // rebuilt each turn, so a startup closure would write into a dead
        // turn's output stream. Every event also reaches the App's mount-time
        // sink (async-subagents.md §4), which renders streamed text deltas
        // into the transcript regardless of turn state; the per-turn bundle
        // keeps rendering the ⌁ start/tool/end lines with the current turn's
        // elapsed-time context.
        orchestrator.setOnSubagentProgress((event) => {
          if (event.kind !== "text") cb.onSubagentProgress?.(event);
          appSubagentSink?.(event);
        });
        return runAgentTurnBridge(input, cb, shared, permissions, permissionProfile, getProvider, getCompactor(), diagnostics, skills, agents, memoryInjection, memoryStore, sessionStore, sessionId, modeLoader, skillLoader, imageUrls, planMode, checkpoints, configResult.config.notify, configResult.config.env, notifySpawnOptions, errorReflector, errorRecovery, repomapInjection, dirtyBaseline, thinkingEnabled, getActiveModelCaps()?.contextWindow, hooks);
      },
      // Async sub-agent delivery (async-subagents.md §2): the App registers its
      // session-scoped wake handler here; the orchestrator calls it once per
      // completed sub-run with the formatted result message.
      setSubagentResultHandler: (handler: (taskId: string, message: string) => void) => orchestrator.setOnTaskResult(handler),
      // Die on exit (async-subagents.md §3, Q3): the App calls this on /exit so
      // pending sub-runs are marked aborted and never wake a dying app.
      abortRunningTasks: () => orchestrator.tasks.abortAll(),
      // Async sub-run surfaces (async-subagents.md §3-4): the /tasks view reads
      // the live registry snapshot and stops one task at a time; the App's
      // mount-time text sink registers here.
      getTasks: () => orchestrator.tasks.list(),
      abortTask: (taskId: string) => orchestrator.abortTask(taskId),
      setSubagentProgress: (handler: ((event: SubagentProgress) => void) | undefined) => { appSubagentSink = handler; },
      resumeSession: async (id: string) => {
        try {
          const loaded = await sessionStore.loadEffective(id);
          shared.conversationHistory = loaded.messages;
          sessionId = id;
          setSessionId(id);
          return loaded.messages;
        } catch {
          return null;
        }
      },
      restoreCheckpoint: async (hash: string, restoreCode: boolean) => {
        const ck = checkpoints;
        if (restoreCode) {
          const result = await ck.restoreFrom(hash);
          if (!result.restored) return { restored: false, promptDraft: "" };
        }
        const entries = await ck.list();
        const found = entries.find((e) => e.hash === hash);
        if (found) {
          const convMatch = found.message.match(/\[convLen:(\d+)\]/);
          if (convMatch) {
            const len = parseInt(convMatch[1], 10);
            if (len >= 0 && len <= shared.conversationHistory.length) {
              shared.conversationHistory = shared.conversationHistory.slice(0, len);
            }
          }
        }
        const msgMatch = found?.message.match(/\]\s+(.+)/);
        return { restored: true, promptDraft: msgMatch ? msgMatch[1] : "" };
      },
      showResumeOnStart: showResumeChooserOnStart,
      initialNotice,
      initialMessages: sessionLoaded ? sessionMessages : undefined,
      compactResumed: async (): Promise<Message[] | null> => {
        // Explicit user request from the resume chooser — bypass the auto
        // threshold and compact whatever was loaded. Mirrors the persist path in
        // agent.ts: summarize old turns, write a non-destructive compaction
        // overlay (raw log stays on disk), and update the live history.
        const msgs = shared.conversationHistory;
        if (msgs.length === 0) return null;
        const compactor = getCompactor();
        const persistedCount = await sessionStore.getMessageCount(sessionId);
        // Drop the leading system prompt (if any) from the summarized span; it is
        // rebuilt per turn and shouldn't be baked into the summary.
        const withoutSystem = msgs[0]?.role === "system" ? msgs.slice(1) : msgs;
        const keepCount = keepBoundary(withoutSystem);
        const old = withoutSystem.slice(0, withoutSystem.length - keepCount);
        const recent = withoutSystem.slice(withoutSystem.length - keepCount);
        if (old.length === 0) return null;
        const summaryText = await compactor.summarizeForResume(old);
        const summaryMsg: Message = {
          role: "user",
          content: `[Previous conversation summary]\n${summaryText}`,
        };
        const compacted = [summaryMsg, ...recent];
        shared.conversationHistory = compacted;
        if (persistedCount > 0) {
          const summary: CompactionSummary = {
            task: summaryText,
            decisions: [],
            files: [],
            errors_resolved: [],
          };
          await sessionStore.appendCompaction(sessionId, persistedCount - 1, summary);
        }
        return compacted;
      },
      theme: resolvedTheme,
      keybindings: resolvedKeybindings,
      keybindingConfig: resolvedKeybindingConfig,
      tabState: undefined,
      workflowConfig,
    };

    const inkInstance = render(
      createElement(App, {
        ctx: appCtx,
        themeConfig: { mode: configResult.config.theme?.mode ?? "dark", name: configResult.config.theme?.name, overrides: configResult.config.theme?.overrides },
        keybindingConfig: resolvedKeybindingConfig,
        refresh: resolveRefreshProfile(process.env, configResult.config.refresh),
      }),
      {
        exitOnCtrlC: false,
        // Ink defaults to erasing the ENTIRE frame and redrawing it on every
        // render — measured as `\x1b[2K\x1b[1A` repeated once per row, 465 bytes
        // per tick for a small frame. At the working indicator's 80ms cadence
        // that is a full-screen clear-and-repaint 12.5x/second, which is what
        // the terminal shows as flicker (badly on slower emulators like
        // IntelliJ's). Incremental mode moves the cursor and rewrites only the
        // lines that actually changed: same frame, 69 bytes, no erase at all.
        incrementalRendering: true,
      },
    );

    // Ink's own resize handler erases its old frame using a line count that
    // ignores terminal re-wrapping, stranding frame copies when the window
    // narrows. Swap in a wrap-aware repaint (no-op fallback to stock behavior
    // if Ink's internals ever change shape). See core/resize-repaint.ts.
    void installResizeRepaintFix(process.stdout);

    const exitPromise = inkInstance.waitUntilExit();
    restartRef.current = () => {
      restarting = true;
      process.stdout.write(ANSI_CLEAR_SCREEN);
      exitPromise.then(() => {
        if (!restarting) { restartRef.current = null; process.exit(0); }
      });
      startApp();
    };
  }

  if (process.env.NIB_PROFILE === "1" || process.env.NIB_PROFILE === "true") {
    stallWatchdog = startStallWatchdog();
  }

  startApp();
}

function detectProvider(configEnv: Record<string, string | undefined> | undefined): string | null {
  if (configEnv?.BASE_URL) {
    if (configEnv.BASE_URL.includes("deepseek")) return "deepseek";
    if (configEnv.BASE_URL.includes("openai")) return "openai";
    if (configEnv.BASE_URL.includes("openrouter")) return "openrouter";
    if (configEnv.BASE_URL.includes("groq")) return "groq";
  }
  const envProviders = [
    { name: "deepseek", key: "DEEPSEEK_API_KEY" },
    { name: "openai", key: "OPENAI_API_KEY" },
    { name: "openrouter", key: "OPENROUTER_API_KEY" },
    { name: "anthropic", key: "ANTHROPIC_API_KEY" },
    { name: "groq", key: "GROQ_API_KEY" },
    { name: "together", key: "TOGETHER_API_KEY" },
  ];
  for (const p of envProviders) { if (process.env[p.key]) return p.name; }
  return null;
}

function getProviderLabels(): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const provName of getKnownProviderNames()) {
    const preset = getPreset(provName);
    labels[provName] = preset?.label ?? provName;
  }
  return labels;
}
function getProviderLabel(name: string): string { return getPreset(name)?.label ?? name; }

function getKeyEnvByProvider(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const provName of getKnownProviderNames()) {
    const keyEnv = getPreset(provName)?.keyEnv;
    if (keyEnv) out[provName] = keyEnv;
  }
  return out;
}

/**
 * Record a successful /model switch into settings.json's recentModels list,
 * for the picker's Recent group. A model already favorited is skipped — the
 * picker keeps Recent and Favorites disjoint. Best-effort: a write failure
 * (e.g. read-only HOME) must never break the model switch itself.
 */
function recordRecentModel(id: string): void {
  try {
    if (loadFavoriteModels().includes(id)) return;
    persistRecentModel(id, Date.now());
  } catch {
    // Best-effort — the /model switch already succeeded and must not fail here.
  }
}

function listKnownModels(): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const provName of getKnownProviderNames()) {
    const preset = getPreset(provName);
    const seen = new Set<string>();
    if (preset) {
      for (const [modelName, caps] of Object.entries(preset.models)) {
        entries.push({
          provider: provName,
          model: modelName,
          contextWindow: caps.contextWindow,
          displayName: caps.displayName,
          providerLabel: preset.label,
          free: caps.free,
        });
        seen.add(modelName);
      }
    }
    const models = getProviderModels(provName);
    if (models) { for (const [modelName, info] of Object.entries(models)) { if (seen.has(modelName)) continue; entries.push({ provider: provName, model: modelName, contextWindow: info.contextWindow, providerLabel: preset?.label }); } }
  }
  return entries;
}

/** Slash commands offered by Tab completion: the autocomplete menu's set plus the headless-routed extras (cli-spec.md §5). */
const SLASH_COMMANDS = [
  ...BUILTIN_SLASH_COMMANDS.map(c => c.label),
  "/cost", "/context", "/modes", "/skill", "/sessions", "/rename",
];

/**
 * Completion engine behind prompt Tab (cli-spec.md §5). Contract: returns
 * `[hits, base]` where `base` is the typed stem — a suffix of `line` — and
 * applying a completion replaces that stem with a hit.
 */
export function completer(line: string, knownModeSlugs: string[], extraSlashCommands: string[] = []): [string[], string] {
  // Custom slash commands join the builtin set; a custom name that collides
  // with a builtin is shadowed by it (builtins are inserted first, dedupe wins).
  const allSlashCommands = [...new Set([
    ...SLASH_COMMANDS,
    ...extraSlashCommands.map((c) => (c.startsWith("/") ? c : `/${c}`)),
  ])];
  // Empty/whitespace-only line (bare Tab at the prompt start): complete slash
  // commands; the whole line is the stem.
  if (line.trim() === "") {
    return [allSlashCommands.slice(), line];
  }
  const modelArgMatch = line.match(/^\/model\s+(\S*)$/);
  if (modelArgMatch) {
    const partial = modelArgMatch[1];
    const all = listKnownModels().map(e => `${e.provider}/${e.model}`);
    const hits = all.filter(m => m.startsWith(partial));
    return [hits, partial];
  }
  const modeArgMatch = line.match(/^\/mode\s+(\S*)$/);
  if (modeArgMatch) {
    const partial = modeArgMatch[1];
    const hits = knownModeSlugs.filter(s => s.startsWith(partial));
    return [hits, partial];
  }
  if (line.startsWith("/")) {
    const hits = allSlashCommands.filter(c => c.startsWith(line));
    if (hits.length === 1) return [hits.map(h => h + " "), line];
    return [hits, line];
  }
  const atMatch = line.match(/@(\S*)$/);
  if (atMatch) {
    const partial = atMatch[1];
    return [pathHits(partial).map(h => `@${h}`), `@${partial}`];
  }
  // A bare path token mid-line ("look at docs/fea"): complete as a path.
  const tail = line.match(/(\S*)$/)?.[1] ?? "";
  if (tail && !tail.startsWith("/") && !tail.startsWith("@") && tail.includes("/")) {
    return [pathHits(tail), tail];
  }
  return [[], line];
}

/** Filesystem completions for a path stem, relative to cwd; directories get a trailing "/" so the next Tab drills in. */
function pathHits(partial: string): string[] {
  const dir = partial.includes("/") ? dirname(partial) : ".";
  const prefix = partial.includes("/") ? partial.split("/").pop()! : partial;
  try {
    const base = resolve(process.cwd(), dir);
    const entries = readdirSync(base, { withFileTypes: true });
    return entries.filter(e => !e.name.startsWith(".") && e.name.startsWith(prefix)).map(e => {
      const relPath = dir === "." ? e.name : `${dir}/${e.name}`;
      return relPath + (e.isDirectory() ? "/" : "");
    });
  } catch { return []; }
}

function extractDecisions(summary: string | null): string[] {
  if (!summary) return [];
  return summary.split(/(?<=[.!?])\s+/).filter(s => /\b(decided|decision|chose|opted|selected|agreed|resolved|concluded|determined)\b/i.test(s)).map(s => s.trim());
}

// Dispatch for `nib auth ...`. Returns the process exit code.
//   auth                          → interactive wizard (masked key prompt)
//   auth list                     → list configured providers
//   auth logout <provider>        → remove a credential
//   auth <provider> --api-key <k> → non-interactive save (alias -k), no prompt
//   auth <provider>               → save key for <provider>: masked prompt on a
//                                   TTY, or one line read verbatim from a pipe
//                                   (e.g. `echo KEY | nib auth <provider>`)
async function runAuth(args: string[]): Promise<number> {
  const sub = args[0];

  if (sub === "list") { await authList(); return 0; }
  if (sub === "logout") {
    if (args[1]) { await authLogout(args[1]); return 0; }
    console.log("Usage: nib auth logout <provider>");
    return 0;
  }
  if (sub === undefined) { await authWizard(); return 0; }

  // A provider name was given: `auth <provider> [--api-key <key>]`.
  const provider = sub;
  let apiKey: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--api-key" || a === "-k") {
      apiKey = args[++i];
    } else if (a.startsWith("--api-key=")) {
      apiKey = a.slice("--api-key=".length);
    } else {
      console.error(`Unknown argument: ${a}`);
      console.error("Usage: nib auth <provider> [--api-key <key>]");
      return 1;
    }
  }

  if (apiKey !== undefined) {
    const trimmed = apiKey.trim();
    if (!trimmed) { console.error("API key cannot be empty."); return 1; }
    await authSaveKey(provider, trimmed);
    return 0;
  }

  // No flag: read the key from the masked TTY prompt, or verbatim from a pipe.
  const key = await readHiddenLine(`Paste your API key for ${provider}: `);
  if (key === null) { console.log("Cancelled. No credentials saved."); return 0; }
  const trimmed = key.trim();
  if (!trimmed) { console.error("API key cannot be empty."); return 1; }
  await authSaveKey(provider, trimmed);
  return 0;
}

export interface SearXngHealth {
  ok: boolean;
  ms: number;
}

/**
 * GETs `{searxngUrl}/healthz` with a 3 s hard timeout and no retries — doctor
 * diagnostics, deliberately not the web_search tool path (which has its own
 * retry/fallback policy). `fetchImpl` and `timeoutMs` injectable for tests
 * (same pattern as probeSyncOutput).
 */
export async function probeSearXngHealth(
  searxngUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000,
): Promise<SearXngHealth> {
  const started = Date.now();
  try {
    const res = await fetchImpl(`${searxngUrl.replace(/\/+$/, "")}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    return { ok: res.ok, ms: Date.now() - started };
  } catch {
    return { ok: false, ms: Date.now() - started };
  }
}

export async function runDoctor(): Promise<void> {
  console.log("nib doctor\n");
  try { const { execSync } = await import("node:child_process"); console.log(`  git               ${execSync("git --version", { encoding: "utf-8" }).trim()}`); }
  catch { console.log(`  git               NOT FOUND`); }
  try { const configResult = loadConfig(); console.log(`  settings.json     model: ${configResult.config.model || configResult.config.env?.MODEL || "(not set)"}`); }
  catch (e) { console.log(`  settings.json     ERROR: ${(e as Error).message}`); }
  const keySource = process.env.DEEPSEEK_API_KEY ? "DEEPSEEK_API_KEY env var" : process.env.OPENAI_API_KEY ? "OPENAI_API_KEY env var" : (() => { const names = Object.entries(readCredentialsFile()).filter(([, v]) => v).map(([k]) => k); return names.length ? `credentials.yaml (${names.join(", ")})` : "none"; })();
  console.log(`  API key           ${keySource}`);
  const configResult = loadConfig();
  const issues = [...configResult.errors, ...configResult.warnings];
  console.log(`  config            ${issues.length === 0 ? "valid" : `${issues.length} issue(s):\n${issues.map(i => `                    - ${i}`).join("\n")}`}`);
  const searxngUrl = configResult.config.webSearch?.searxngUrl;
  if (searxngUrl) {
    const health = await probeSearXngHealth(searxngUrl);
    console.log(`  SearXNG           ${health.ok ? `ok (${health.ms} ms)` : "unreachable — searches will fall back to Bing."}`);
  }
  console.log(`  node              ${process.version}`);
  // Surface the repaint cadence, and say plainly when an env value was not
  // understood — resolveRefreshProfile falls back silently so a typo cannot
  // stop the CLI starting, which otherwise leaves no way to tell whether
  // NIB_REFRESH took effect.
  const refresh = resolveRefreshProfile(process.env, loadConfig().config.refresh);
  const source = describeRefreshSource(refresh);
  console.log(`  refresh           ${refresh.name} ${source}`);
  console.log(`                    flush ${refresh.flushMs}ms · indicator ${refresh.indicatorMs}ms · options: ${REFRESH_PROFILE_NAMES.join(" | ")}`);
  const syncOutput = await probeSyncOutput();
  const syncOutputLine =
    syncOutput === "supported"
      ? "supported (DEC 2026 — frames paint atomically)"
      : syncOutput === "unsupported"
        ? "unsupported — terminal paints partial writes; expect tearing while streaming"
        : syncOutput === "no-response"
          ? "no response (treated as unsupported)"
          : "skipped (not a TTY)";
  console.log(`  sync-output       ${syncOutputLine}`);
  if (stallWatchdog) {
    console.log(`  profiling  active — stalls so far: ${stallWatchdog.getStallCount()}`);
  }
}

export async function handleSlashCore(
  input: string, getProvider: any,
  configResult: any, modeLoader: ModeLoader, permissions: PermissionEngine, sessionStore: SessionStore,
  sessionId: string, checkpoints: CheckpointManager, memoryStore: MemoryStore, memoryInjection: string | null | undefined,
  getCompactor: () => Compactor, diagnostics: DiagnosticRunner, skills: SkillDef[], skillLoader: SkillLoader,
  shared: any, getActiveModelCaps: () => ModelCapabilities | undefined,
  getCostStr: () => string | null, colorEnabled: boolean, reasoningEffort: string | undefined,
  resetCompactor: () => void,
  getOverheadTokens?: () => number,
  agents: AgentDef[] = [],
): Promise<void> {
  const cmd = input.trim().split(/\s+/)[0];
  switch (cmd) {
    case "/help": {
      console.log("Commands: /exit, /help, /mode <name>, /clear, /modes, /sessions, /new, /skills, /skill <name>, /model <p/m>, /cost, /context, /usage, /effort, /rename <title>\nUse `nib auth` to configure a provider.");
      return;
    }
    case "/cost": {
      console.log(`Session: ${(shared.sessionInput / 1000).toFixed(1)}k in / ${(shared.sessionOutput / 1000).toFixed(1)}k out`);
      if (configResult.config.showCost) {
        const cost = getCostStr();
        console.log(`Estimated cost: $${cost ?? "0.0000"}`);
      }
      return;
    }
    case "/usage": {
      // Headless /usage — the TUI opens the UsageView instead (App.tsx). Same
      // rows: a balance line (live query, decision I — no caching) plus the
      // per-model token breakdown. getBalance is optional on the adapter;
      // absent, null, or a failed query all read as "not supported".
      let balance: ProviderBalance | null = null;
      try {
        const provider = getProvider();
        balance = (await provider.getBalance?.()) ?? null;
      } catch {
        balance = null;
      }
      if (balance) {
        const remaining = balance.total - balance.granted;
        console.log(`Balance (${balance.currency}): total $${balance.total.toFixed(2)} / granted $${balance.granted.toFixed(2)} / remaining $${remaining.toFixed(2)}`);
      } else {
        console.log(`Balance: not supported for ${shared.providerName}`);
      }
      console.log(`Session: ${(shared.sessionInput / 1000).toFixed(1)}k in / ${(shared.sessionOutput / 1000).toFixed(1)}k out`);
      const usageByModel = (shared.modelUsage ?? {}) as Record<string, { input: number; output: number; cached: number }>;
      const modelKeys = Object.keys(usageByModel);
      if (modelKeys.length === 0) {
        console.log("Tokens by model: none recorded yet this session");
      } else {
        for (const model of modelKeys) {
          const u = usageByModel[model];
          console.log(`  ${model}: ${u.input.toLocaleString("en-US")} in / ${u.output.toLocaleString("en-US")} out / ${u.cached.toLocaleString("en-US")} cached`);
        }
      }
      return;
    }
    case "/context": {
      const preset = getPreset(shared.providerName);
      const caps = preset?.models[shared.activeModel ?? preset.defaultModel];
      const cw = caps?.contextWindow ?? 128000;
      const threshold = configResult.config.compaction?.threshold ?? 0.7;
      const compactionCutoff = compactionCutoffTokens(cw, threshold);

      const breakdown = estimateTokensDetailed(shared.conversationHistory);
      const sysTokens = breakdown.filter(b => b.role === "system").reduce((s, b) => s + b.tokens, 0);
      const userTokens = breakdown.filter(b => b.role === "user").reduce((s, b) => s + b.tokens, 0);
      const asstTokens = breakdown.filter(b => b.role === "assistant").reduce((s, b) => s + b.tokens, 0);
      const toolTokens = breakdown.filter(b => b.role === "tool").reduce((s, b) => s + b.tokens, 0);
      const convTokens = userTokens + asstTokens + toolTokens;
      // Tool schemas + repo map: on the request, absent from conversationHistory.
      const overheadTokens = getOverheadTokens?.() ?? 0;
      const totalUsed = sysTokens + convTokens + overheadTokens;
      const remaining = Math.max(0, cw - totalUsed);
      const pct = (v: number) => ((v / cw) * 100).toFixed(1);
      const bar = (v: number, width: number) => `${"\u2501".repeat(Math.round((v / cw) * width))}`;

      console.log(`Context Window: ${cw.toLocaleString()} tokens`);
      console.log(`\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
      console.log(`System Prompt     ${String(sysTokens).padStart(6)}  (${pct(sysTokens).padStart(5)}%)`);
      console.log(`Conversation      ${String(convTokens).padStart(6)}  (${pct(convTokens).padStart(5)}%)`);
      console.log(`  \u251C User msgs    ${String(userTokens).padStart(6)}`);
      console.log(`  \u251C Assistant    ${String(asstTokens).padStart(6)}`);
      console.log(`  \u2514 Tool results  ${String(toolTokens).padStart(6)}`);
      console.log(`Tools + RepoMap   ${String(overheadTokens).padStart(6)}  (${pct(overheadTokens).padStart(5)}%)`);
      console.log(`\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
      console.log(`Total Used        ${String(totalUsed).padStart(6)}  (${pct(totalUsed).padStart(5)}%)`);
      console.log(`Remaining         ${String(remaining).padStart(6)}  (${pct(remaining).padStart(5)}%)`);
      console.log(`Context editing @ ${String(CONTEXT_EDITING_TRIGGER_TOKENS).padStart(6)}  (clears old consumed results; keeps ${RECENT_TOOL_RESULTS_TO_KEEP} + fresh batch)`);
      console.log(`Compaction @      ${String(Math.round(compactionCutoff)).padStart(6)}  (${String(Math.round((compactionCutoff / cw) * 100)).padStart(3)}%)`);
      return;
    }
    case "/doctor": {
      // Same information as `nib doctor`, but reachable without leaving
      // the session — the shell subcommand is intercepted before the UI starts,
      // so it was the one place you could not check the running session's own
      // settings.
      const refresh = resolveRefreshProfile(process.env, configResult.config.refresh);
      const source = describeRefreshSource(refresh);
      console.log(`provider   ${shared.providerName}`);
      console.log(`model      ${shared.activeModel ?? getPreset(shared.providerName)?.defaultModel ?? "unknown"}`);
      console.log(`effort     ${shared.activeEffort ?? "(none)"}`);
      console.log(`refresh    ${refresh.name} ${source}`);
      console.log(`           flush ${refresh.flushMs}ms · indicator ${refresh.indicatorMs}ms · options: ${REFRESH_PROFILE_NAMES.join(" | ")}`);
      console.log(`node       ${process.version}`);
      // Not run in-session: stdin here is owned by useTerminalInput's custom
      // wire, which would swallow the terminal's DECRQM reply bytes before
      // the probe ever saw them.
      const probeNote = "terminal probe: run `nib doctor` from a shell";
      console.log(colorEnabled ? `\x1b[2m${probeNote}\x1b[0m` : probeNote);
      if (stallWatchdog) {
        console.log(`profiling  active — stalls so far: ${stallWatchdog.getStallCount()}`);
      }
      return;
    }
    case "/skills": {
      if (skills.length === 0) console.log("No skills available.");
      else for (const s of skills) console.log(`  ${s.name} — ${s.description || "no description"}`);
      // Minimal agent surface (§F4): one line naming the defined agents new_task
      // accepts — no separate view.
      if (agents.length > 0) {
        console.log(`Agents: ${agents.map((a) => a.name).sort().join(", ")}`);
      }
      return;
    }
    case "/skill": {
      const name = input.slice(7).trim();
      const skill = skills.find((s: SkillDef) => s.name === name);
      if (!skill) { console.log(`Unknown skill: ${name}`); return; }
      if (isSkillAlreadyLoaded(shared.conversationHistory, name)) {
        return;
      }
      const msg = buildSkillLoadMessage(name, skill.content);
      shared.conversationHistory.push(msg);
      await sessionStore.appendMessage(sessionId, msg);
      return;
    }
    case "/clear": shared.conversationHistory = []; console.log("[cleared]"); return;
    case "/compact": {
      const msgs = shared.conversationHistory as import("./types.js").Message[];
      if (msgs.length === 0) { console.log("[nothing to compact]"); return; }
      const compactor = getCompactor();
      // Keep the system prompt in place: it is the cached stable prefix, and
      // dropping it would strip the agent's rules for the rest of the session.
      const systemMsg = msgs[0]?.role === "system" ? msgs[0] : undefined;
      const withoutSystem = systemMsg ? msgs.slice(1) : msgs;
      // Same boundary as auto-compaction — never orphans a tool result.
      const keepCount = keepBoundary(withoutSystem);
      const old = withoutSystem.slice(0, withoutSystem.length - keepCount);
      const recent = withoutSystem.slice(withoutSystem.length - keepCount);
      if (old.length === 0) { console.log(`[only ${withoutSystem.length} message(s) — nothing to compact]`); return; }
      try {
        const summaryText = await compactor.summarizeForResume(old);
        const summaryMsg: import("./types.js").Message = { role: "user", content: `[Previous conversation summary]\n${summaryText}` };
        shared.conversationHistory = [...(systemMsg ? [systemMsg] : []), summaryMsg, ...recent];
        const persistedCount = await sessionStore.getMessageCount(sessionId);
        if (persistedCount > 0) {
          const summary: import("./sessions/store.js").CompactionSummary = { task: summaryText, decisions: [], files: [], errors_resolved: [] };
          await sessionStore.appendCompaction(sessionId, persistedCount - 1, summary);
        }
        console.log(`[compacted ${old.length} turns · kept ${recent.length} recent]`);
      } catch (err) {
        console.log(`[compaction failed: ${(err as Error).message}]`);
      }
      return;
    }
    case "/rename": {
      // Display name for the current session, shown in /sessions and /resume
      // (flag parity --name). Stored in the index (not the meta record), so it
      // survives the derived-title update from the first message.
      const title = input.slice(7).trim();
      if (!title) { console.log("Usage: /rename <title>"); return; }
      const ok = await sessionStore.renameSession(sessionId, title);
      console.log(ok ? `Renamed session to "${title}".` : `Could not rename session ${sessionId}.`);
      return;
    }
    case "/modes": for (const m of await modeLoader.listAll()) console.log(`  ${m.slug} — ${m.description || m.roleDefinition.slice(0, 60)}`); return;
    case "/sessions": {
      // Headless session list for the cwd, matching the TUI picker's row
      // shape (SessionList.tsx): id, excerpt, age, message count. Newest
      // first — sessionStore.list() sorts by id, which is timestamp-prefixed.
      const sessions = await sessionStore.list();
      if (sessions.length === 0) { console.log("No sessions for this project."); return; }
      const ageOf = (iso: string): string => {
        const diff = Date.now() - new Date(iso).getTime();
        if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
        return new Date(iso).toISOString().slice(0, 10);
      };
      for (const s of sessions) {
        console.log(`  ${s.id}  ${s.title || s.firstMessage || s.id.slice(0, 12)}  ${ageOf(s.updatedAt)}  ${s.messageCount} msgs`);
      }
      return;
    }
    case "/mode": {
      const slug = input.slice(6).trim();
      if (!slug) {
        console.log(`Current: ${shared.activeMode?.slug ?? "general"}`);
        for (const m of await modeLoader.listAll()) console.log(`  ${m.slug} — ${m.description || m.roleDefinition.slice(0, 60)}`);
        return;
      }
      const mode = await modeLoader.load(slug);
      if (mode) { shared.activeMode = mode; syncModeModel(shared, shared.activeMode); await sessionStore.appendState(sessionId, { mode: slug }); console.log(`Switched to ${mode.name} mode.`); }
      else console.log(`Unknown mode: ${slug}.`);
      return;
    }
    case "/model": {
      const modelArg = input.slice(7).trim();
      if (!modelArg) {
        const currentModel = shared.activeModel ?? getPreset(shared.providerName)?.defaultModel ?? "unknown";
        console.log(`Current: ${shared.providerName}/${currentModel}`);
        for (const entry of listKnownModels()) {
          console.log(`  ${entry.provider}/${entry.model}`);
        }
        return;
      }
      const slashIdx = modelArg.indexOf("/");
      if (slashIdx < 0) { console.log("Use /model <provider/model>"); return; }
      const prevProviderName = shared.providerName;
      const prevActiveModel = shared.activeModel;
      const provider = modelArg.slice(0, slashIdx);
      const model = modelArg.slice(slashIdx + 1);
      shared.providerName = provider;
      shared.activeModel = model;
      try {
        getProvider();
      } catch (err) {
        shared.providerName = prevProviderName;
        shared.activeModel = prevActiveModel;
        console.log(`Cannot switch to ${provider}/${model}: ${(err as Error).message}`);
        return;
      }
      shared.modelExplicit = true;
      syncModeModel(shared, shared.activeMode);
      await sessionStore.appendState(sessionId, { provider, model, modelExplicit: true });
      resetCompactor();
      recordRecentModel(toModelId(provider, model));
      console.log(`Model changed to ${shared.providerName}/${shared.activeModel}`);
      return;
    }
    case "/effort": {
      const arg = input.slice(7).trim();
      const caps = getActiveModelCaps();
      if (!caps?.effort) {
        const modelId = shared.activeModel ?? getPreset(shared.providerName)?.defaultModel ?? "unknown";
        console.log(`No verified reasoning-effort values for ${shared.providerName}/${modelId}. Set config.reasoningEffort in settings.json to override.`);
        return;
      }
      if (!arg) { console.log(`Effort: ${shared.activeEffort ?? caps.effort.default}\nValid: ${caps.effort.values.join(", ")}`); return; }
      if (!caps.effort.values.includes(arg)) { console.log(`Invalid effort. Valid: ${caps.effort.values.join(", ")}`); return; }
      shared.activeEffort = arg;
      shared.effortExplicit = true;
      await sessionStore.appendState(sessionId, { effort: arg, effortExplicit: true });
      console.log(`Effort set to ${arg}.`);
      return;
    }
    default: console.log(`Unknown: ${cmd}\nType /help.`); return;
  }
}

async function runAgentTurnBridge(input: string, cb: any, shared: any, permissions: PermissionEngine, permissionProfile: ProfileEvaluator | undefined, getProvider: any, compactor: Compactor, diagnostics: DiagnosticRunner, skills: SkillDef[], agents: AgentDef[], memoryInjection: string | null | undefined, memoryStore: MemoryStore, sessionStore: SessionStore, sessionId: string, modeLoader: ModeLoader, skillLoader: SkillLoader, imageUrls?: string[], planMode?: boolean, checkpoints?: CheckpointManager, notifyScript?: string, notifyEnv?: Record<string, string | undefined>, notifySpawnOptions?: NotifySpawnOptions, errorReflector?: ErrorReflector, errorRecovery?: ErrorRecovery, repomapInjection?: string, dirtyBaseline?: string, thinkingEnabled?: boolean, contextWindow?: number, hooks?: HookRunner): Promise<any> {
  if (checkpoints) {
    const convLen = shared.conversationHistory.length;
    await checkpoints.save(`[convLen:${convLen}] ${input.slice(0, 80)}`);
  }
  shared.sessionUserInputs.push(input);
  // `@file` mentions (Claude Code style): read the referenced files and attach
  // their contents to the model's view of the prompt. The transcript echo and
  // the persisted session keep the raw text — the user's own words — while the
  // model additionally sees the file contents. Unresolvable mentions are left
  // in the prompt as plain text (emails, usernames, typos). Mentions are
  // permission-gated like the read_file tool, through authorize() (profile
  // layer 1, then the rule engine): a path the profile or a read rule denies
  // is replaced with a "not injected" note instead of silently dropped.
  const { blocks: mentionBlocks, imageUrls: mentionImageUrls } = await expandFileMentions(
    input,
    undefined,
    (raw) => (authorize({ tool: "read_file", arguments: { path: raw } }, permissions, permissionProfile).action === "deny" ? "deny" : "allow"),
  );
  const processed = mentionBlocks.length > 0
    ? `${mentionBlocks.join("\n\n")}\n\n${input}`
    : input;
  // Mentioned images join any clipboard attachments on the one channel that
  // carries image bytes to the provider (see mapMessages). Both sources feed
  // the same array, so `@shot.png` and a Ctrl+V paste behave identically.
  const attachedImages = [...(imageUrls ?? []), ...mentionImageUrls];

  // Surface the vision caveat at the moment it matters — an image is being sent
  // and the model is not declared as accepting one. Before this, the failure was
  // silent: the provider ignored the image or rejected the request and nothing on
  // our side said why (the README left it to the user to know).
  const visionWarning = imageSupportWarning(shared.providerName, shared.activeModel, attachedImages.length);
  if (visionWarning) cb.onDiagnostic?.(visionWarning);
  // Plan mode is read-only: offer only read-group tools so the model cannot
  // call an edit/command tool the plan-mode instruction forbids.
  const modeTools = planMode
    ? registry.getByMode(["read"])
    : shared.activeMode?.groups ? registry.getByMode(shared.activeMode.groups) : registry.getAllDefs();
  // CLI --allowed-tools / --disallowed-tools (flag parity) narrow the offered
  // set; empty lists pass everything through.
  const tools = filterToolDefs(modeTools, shared.allowedTools, shared.disallowedTools);

  // Research notes are plan-mode-only context: load them lazily when in plan
  // mode so the per-turn file walk costs nothing in normal conversation.
  const researchInjection = planMode ? (loadProjectResearch(process.cwd()) ?? undefined) : undefined;

  // Notify hook: fires from this interactive completion boundary once the
  // turn's outcome is known (mirrors the headless site in exec-runner.ts).
  // TITLE is the session's first user prompt prefix. Fire-and-forget — see
  // src/notify.ts. No-op when `notify` is unconfigured.
  const notifyStart = Date.now();
  const notifyTitle = String(shared.sessionUserInputs[0] ?? input).slice(0, 120);

  let result;
  try {
    result = await runAgent(processed, {
    provider: getProvider(),
    tools, executeTool, permissions, permissionProfile, mode: shared.activeMode, compactor, diagnostics, skills, agents,
    errorReflector, errorRecovery,
    repomap: repomapInjection,
    dirtyBaseline,
    research: researchInjection,
    memory: memoryInjection ?? undefined, memoryStore, sessionStore, sessionId,
    signal: shared.abort.signal, effort: shared.activeEffort, thinkingEnabled,
    history: shared.conversationHistory.length > 0 ? shared.conversationHistory : undefined,
    imageUrls: attachedImages.length > 0 ? attachedImages : undefined,
    planMode,
    contextWindow,
    maxTurns: shared.maxTurns,
    getTodos: () => todoStore.getTodos(),
    onText: cb.onText, onReasoning: cb.onReasoning, onToolStart: (name, args) => { shared.toolUsage[name] = (shared.toolUsage[name] || 0) + 1; cb.onToolStart(name, args); }, onToolResult: cb.onToolResult,
    onDiagnostic: cb.onDiagnostic, onRetry: cb.onRetry, onCompacted: cb.onCompacted,
    onLoopDetected: cb.onLoopDetected, onMaxTurns: cb.onMaxTurns,
    onUsage: (input: number, output: number, cached?: number) => {
      shared.sessionInput += input; shared.sessionOutput += output; shared.lastContextTokens = input + output;
      const modelKey = `${shared.providerName}/${shared.activeModel ?? getPreset(shared.providerName)?.defaultModel ?? "unknown"}`;
      const existing = shared.modelUsage[modelKey] || { input: 0, output: 0, cached: 0 };
      shared.modelUsage[modelKey] = { input: existing.input + input, output: existing.output + output, cached: existing.cached + (cached ?? 0) };
      sessionStore.appendState(sessionId, { inputTokens: input, outputTokens: output, cumulativeInput: shared.sessionInput, cumulativeOutput: shared.sessionOutput });
      cb.onUsage(input, output);
    },
    askUser: cb.askUser,
    // Mid-turn steering mailbox (App's queue); the loop polls it before each
    // provider call and injects a queued message at the next decision point.
    pollSteeringMessage: cb.pollSteeringMessage,
    hooks,
    });
  } catch (err) {
    const failNotifyInput = {
      status: "failed" as const,
      durationMs: Date.now() - notifyStart,
      body: "",
      title: notifyTitle,
      failReason: err instanceof Error ? err.message : String(err),
    };
    fireNotify(
      notifyScript,
      { ...failNotifyInput, passthroughEnv: notifyEnv },
      { debug: shared.debug, spawn: notifySpawnOptions },
    );
    // Notification hooks fire alongside the notify script (hooks-spec.md §7).
    fireNotificationHooks(hooks, failNotifyInput);
    throw err;
  }

  const lastReply = result.messages[result.messages.length - 1]?.content ?? "";
  const completedNotifyInput = {
    status: "completed" as const,
    durationMs: Date.now() - notifyStart,
    body: lastReply,
    title: notifyTitle,
  };
  fireNotify(
    notifyScript,
    { ...completedNotifyInput, passthroughEnv: notifyEnv },
    { debug: shared.debug, spawn: notifySpawnOptions },
  );
  fireNotificationHooks(hooks, completedNotifyInput);
  return result;
}
