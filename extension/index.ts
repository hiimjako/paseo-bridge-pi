// pi-paseo-bridge: makes terminal-started pi TUI sessions visible and
// steerable in Paseo without modifying Paseo.
//
// How it works: this extension runs inside the TUI process, opens a named
// pipe (Windows) / unix socket keyed on the session file path, and speaks
// pi's RPC JSONL dialect on it - the same dialect `pi --mode rpc` speaks on
// stdio. The companion shim (shim/pi-paseo-shim.js), configured as Paseo's
// pi provider command, connects Paseo's stdio to this pipe when the session
// has a live TUI, and falls through to the real pi otherwise.
//
// It also registers the session with the Paseo daemon (`paseo import`) on
// session start, which causes Paseo to spawn the shim and attach.
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sessionPaths, claimOwner, canonicalSession } from "../shim/session-owner.js";
import { openPaseoClient, paseoHome } from "./paseo-client.js";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Markers and command names must match Paseo's pi adapter
// (@getpaseo/server dist/server/server/agent/providers/pi/agent.js).
const ENTRY_CAPTURE_MARKER = "PASEO_ENTRY_CAPTURE";
const COMMAND_RESULT_MARKER = "PASEO_COMMAND_RESULT";
const CAPTURE_COMMAND = "paseo_capture_entries";
const TREE_COMMAND = "paseo_tree";

const DEBUG = ["1", "true", "on"].includes((process.env.PI_PASEO_BRIDGE_DEBUG ?? "").toLowerCase());
const debugLogFile = path.join(os.homedir(), ".pi", "paseo-bridge", "debug.log");

function debugLog(message: string): void {
  if (!DEBUG) return;
  try {
    fs.mkdirSync(path.dirname(debugLogFile), { recursive: true });
    fs.appendFileSync(debugLogFile, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {
    // never let logging break the TUI
  }
}

const bridgeSettingsFile = path.join(os.homedir(), ".pi", "paseo-bridge", "settings.json");

function readBridgeSettings(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(bridgeSettingsFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeBridgeSettings(patch: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(bridgeSettingsFile), { recursive: true });
  fs.writeFileSync(bridgeSettingsFile, `${JSON.stringify({ ...readBridgeSettings(), ...patch }, null, 2)}\n`);
}

function isAutoEnabled(): boolean {
  return readBridgeSettings().auto !== false;
}

function bridgeShimPath(): string {
  // extension/index.ts lives in <package root>/extension/
  let here: string;
  try {
    here = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    here = __dirname;
  }
  return path.join(path.dirname(here), "shim", "pi-paseo-shim.js");
}

const paseoConfigFile = path.join(paseoHome(), "config.json");

function isOurShimCommand(command: unknown): boolean {
  return (
    Array.isArray(command) &&
    command.some(
      (part) => typeof part === "string" && part.replaceAll("\\", "/").toLowerCase().endsWith("/shim/pi-paseo-shim.js"),
    )
  );
}

// Returns a user-facing result message. Throws only on unreadable JSON.
function installShimIntoPaseoConfig(): { ok: boolean; message: string } {
  const config = fs.existsSync(paseoConfigFile) ? JSON.parse(fs.readFileSync(paseoConfigFile, "utf8")) : {};
  config.agents = config.agents ?? {};
  config.agents.providers = config.agents.providers ?? {};
  const current = config.agents.providers.pi?.command;
  if (isOurShimCommand(current)) {
    return { ok: true, message: "Paseo shim already installed" };
  }
  if (current) {
    return {
      ok: false,
      message: `Paseo config already overrides the pi provider command (${JSON.stringify(current)}). Remove agents.providers.pi.command from ~/.paseo/config.json first.`,
    };
  }
  config.agents.providers.pi = {
    ...(config.agents.providers.pi ?? {}),
    command: [process.execPath.replaceAll("\\", "/"), bridgeShimPath().replaceAll("\\", "/")],
  };
  fs.mkdirSync(path.dirname(paseoConfigFile), { recursive: true });
  fs.writeFileSync(paseoConfigFile, `${JSON.stringify(config, null, 2)}\n`);
  return { ok: true, message: "Paseo shim installed. Restart the Paseo daemon to apply: paseo restart" };
}

function uninstallShimFromPaseoConfig(): { ok: boolean; message: string } {
  if (!fs.existsSync(paseoConfigFile)) return { ok: true, message: "Paseo shim was not installed" };
  const config = JSON.parse(fs.readFileSync(paseoConfigFile, "utf8"));
  const piProvider = config?.agents?.providers?.pi;
  if (!piProvider || !piProvider.command) {
    return { ok: true, message: "Paseo shim was not installed" };
  }
  if (!isOurShimCommand(piProvider.command)) {
    return {
      ok: false,
      message: `Leaving Paseo config untouched - the pi provider command is not the bridge shim: ${JSON.stringify(piProvider.command)}`,
    };
  }
  delete piProvider.command;
  if (Object.keys(piProvider).length === 0) delete config.agents.providers.pi;
  if (Object.keys(config.agents.providers).length === 0) delete config.agents.providers;
  if (Object.keys(config.agents).length === 0) delete config.agents;
  fs.writeFileSync(paseoConfigFile, `${JSON.stringify(config, null, 2)}\n`);
  return { ok: true, message: "Paseo shim removed. Restart the Paseo daemon to apply: paseo restart" };
}

function decodeCommandPayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw.trim(), "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n");
}

function resolvePaseoCli(): string | null {
  const override = process.env.PASEO_CLI;
  if (override && fs.existsSync(override)) return override;
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["paseo.cmd", "paseo.bat", "paseo.exe", "paseo"] : ["paseo"];
  for (const dir of pathDirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep scanning
      }
    }
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const desktop = path.join(process.env.LOCALAPPDATA, "Programs", "Paseo", "resources", "bin", "paseo.cmd");
    if (fs.existsSync(desktop)) return desktop;
  }
  return null;
}

function runPaseoCli(cli: string, args: string[], onDone: (code: number | null, output: string) => void): void {
  let child;
  if (process.platform === "win32" && !cli.endsWith(".exe")) {
    // Node refuses to spawn .cmd files without a shell; go through cmd.exe
    // with /s so the outer quotes survive.
    const quoted = [cli, ...args].map((a) => `"${a.replaceAll('"', '""')}"`).join(" ");
    child = spawn("cmd.exe", ["/d", "/s", "/c", `"${quoted}"`], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  } else {
    child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"] });
  }
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk) => (output += chunk.toString()));
  const timer = setTimeout(() => child.kill(), 20000);
  child.on("error", (err) => {
    clearTimeout(timer);
    onDone(null, String(err));
  });
  child.on("exit", (code) => {
    clearTimeout(timer);
    onDone(code, output);
  });
}

export default function piPaseoBridge(pi: ExtensionAPI) {
  if (["0", "off", "false"].includes((process.env.PI_PASEO_BRIDGE ?? "").toLowerCase())) return;

  let server: net.Server | null = null;
  let client: net.Socket | null = null;
  let currentSessionFile: string | null = null;
  let releaseOwner: (() => void) | null = null;
  let latestCtx: ExtensionContext | null = null;
  let isCompacting = false;
  const pendingAborts = new Set<{ id: unknown; socket: net.Socket; manualCompaction: boolean }>();
  let manualCompaction = false;
  let compactionIdleCheck: ReturnType<typeof setTimeout> | null = null;
  let autoCompactionEnabled = true;
  const importAttempted = new Set<string>();
  let currentAgentId: string | null = null;
  // Values Paseo just applied through the bridge; used to break the echo
  // loop when pushing TUI-side changes back to the daemon.
  let remoteAppliedModel: string | null = null;
  let remoteAppliedThinking: string | null = null;
  let titleAttempted = false;

  // Each operation reconnects/authenticates using current instance credentials.
  // No raw server errors or frames are logged (they can contain secrets).
  async function withPaseoClient<T>(operation: (client: DaemonClient) => Promise<T>): Promise<T> {
    const conn = openPaseoClient();
    try {
      await conn.connect();
      return await operation(conn);
    } finally {
      await conn.close();
    }
  }

  function syncPaseo(operation: (client: DaemonClient) => Promise<unknown>): void {
    void withPaseoClient(operation).catch(() => debugLog("Paseo state sync failed; check selected instance/authentication"));
  }

  async function setPaseoWorkspaceTitle(agentId: string, title: string): Promise<void> {
    try {
      await withPaseoClient(async (conn) => {
        const fetched = await conn.fetchAgent(agentId);
        const workspaceId = fetched?.agent?.workspaceId;
        if (workspaceId) await conn.setWorkspaceTitle(workspaceId, `[TUI] ${title}`);
      });
    } catch {
      debugLog("Paseo workspace title sync failed");
    }
  }

  function pushAgentConfigToPaseo(kind: "model" | "thinking", value: string | null): void {
    if (!currentAgentId) return;
    const agentId = currentAgentId;
    syncPaseo((conn) => kind === "model"
      ? conn.setAgentModel(agentId, value)
      : conn.setAgentThinkingOption(agentId, value));
  }

  function modelToId(model: { provider?: string; id?: string } | null | undefined): string | null {
    return model?.provider && model.id ? `${model.provider}/${model.id}` : null;
  }

  function send(obj: unknown): void {
    if (!client || client.destroyed) return;
    try {
      client.write(`${JSON.stringify(obj)}\n`);
    } catch (err) {
      debugLog(`send failed: ${String(err)}`);
    }
  }

  type AskResponse = { index: number } | { text: string } | null;
  type AskRequest = {
    id: string; question: string; options: { label: string; description?: string }[];
    signal: AbortSignal; respond: (response: AskResponse) => void;
  };
  type PendingAsk = {
    request: AskRequest; socket: net.Socket; agentId: string;
    dialogId: string; step: "select" | "input"; options: string[]; abort: () => void;
  };
  const pendingAsks = new Map<string, PendingAsk>();

  function retireAsk(pending: PendingAsk): void {
    pendingAsks.delete(pending.request.id);
    pending.request.signal.removeEventListener("abort", pending.abort);
  }

  function cleanAskCard(pending: PendingAsk, response: AskResponse): void {
    // Capture the originating card/agent before any asynchronous work or step change.
    const { dialogId, agentId, step, options } = pending;
    const answer = response === null ? null : step === "select"
      ? ("index" in response ? options[response.index - 1] : options.at(-1))
      : ("text" in response ? response.text : pending.request.options[response.index - 1]?.label);
    void withPaseoClient(async (conn) => {
      // A local answer can beat the daemon's registration of the just-written frame.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await conn.respondToPermissionAndWait(agentId, dialogId, answer == null
            ? { behavior: "deny" }
            : { behavior: "allow", updatedInput: { answers: { Response: answer } } }, 500);
          return;
        } catch {
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      debugLog("Paseo question cleanup failed");
    }).catch(() => debugLog("Paseo question cleanup failed"));
  }

  function dropAsks(socket: net.Socket): void {
    for (const pending of pendingAsks.values()) {
      if (pending.socket !== socket) continue;
      retireAsk(pending);
      cleanAskCard(pending, null);
    }
  }

  function sendAsk(pending: PendingAsk): void {
    try {
      pending.socket.write(`${JSON.stringify({
        type: "extension_ui_request", id: pending.dialogId, method: pending.step,
        title: pending.request.question,
        ...(pending.step === "select" ? { options: pending.options } : {}),
      })}\n`);
    } catch {
      retireAsk(pending);
      cleanAskCard(pending, null);
      debugLog("Paseo question forwarding failed");
    }
  }

  pi.events.on("ask-user:request", (request: AskRequest) => {
    if (!client || client.destroyed || !client.writable || !currentAgentId || request.signal.aborted) return;
    if (pendingAsks.has(request.id)) return;
    const pending: PendingAsk = {
      request, socket: client, agentId: currentAgentId, dialogId: crypto.randomUUID(), step: "select",
      options: [...request.options.map((option, index) =>
        `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`),
        `${request.options.length + 1}. Write my own answer…`],
      abort: () => { retireAsk(pending); cleanAskCard(pending, null); },
    };
    pendingAsks.set(request.id, pending);
    request.signal.addEventListener("abort", pending.abort, { once: true });
    sendAsk(pending);
  });

  pi.events.on("ask-user:resolved", (event: { id: string; response: AskResponse }) => {
    const pending = pendingAsks.get(event.id);
    if (!pending) return;
    // Retire before cleanup: daemon replies to cleanup must never answer the tool.
    retireAsk(pending);
    cleanAskCard(pending, event.response);
  });

  function handleAskResponse(cmd: any, socket: net.Socket): void {
    const pending = [...pendingAsks.values()].find((entry) => entry.dialogId === cmd.id && entry.socket === socket);
    if (!pending || socket !== client || socket.destroyed || pending.request.signal.aborted) return;
    let response: AskResponse;
    if (cmd.cancelled === true) {
      response = null;
    } else {
      if ((cmd.cancelled !== undefined && cmd.cancelled !== false) || typeof cmd.value !== "string") return;
      if (pending.step === "select") {
        const index = pending.options.indexOf(cmd.value);
        if (index < 0) return;
        if (index === pending.options.length - 1) {
          pending.step = "input";
          pending.dialogId = crypto.randomUUID();
          sendAsk(pending);
          return;
        }
        response = { index: index + 1 };
      } else {
        if (!cmd.value.trim()) return;
        response = { text: cmd.value.trim() };
      }
    }
    retireAsk(pending);
    try { pending.request.respond(response); }
    catch { debugLog("Paseo question response failed"); }
  }

  function notifyTui(message: string): void {
    if (latestCtx?.mode !== "tui") return;
    try {
      latestCtx.ui.notify(message, "info");
    } catch (err) {
      debugLog(`notifyTui failed: ${String(err)}`);
    }
  }

  function notifyEvent(message: string): void {
    send({
      type: "extension_ui_request",
      id: crypto.randomUUID(),
      method: "notify",
      message,
      notifyType: "info",
    });
  }

  function capturedUserEntries(ctx: ExtensionContext): Array<{ id: string; parentId: string | null; text: string }> {
    return ctx.sessionManager
      .getEntries()
      .filter((entry: any) => entry.type === "message" && entry.message?.role === "user")
      .map((entry: any) => ({
        id: entry.id,
        parentId: entry.parentId ?? null,
        text: readTextContent(entry.message.content),
      }));
  }

  function emitEntryCapture(ctx: ExtensionContext | null, reason: string, requestId?: string): void {
    if (!ctx) return;
    try {
      const entries = capturedUserEntries(ctx);
      notifyEvent(`${ENTRY_CAPTURE_MARKER} ${JSON.stringify({ reason, requestId, entries })}`);
    } catch (err) {
      debugLog(`entry capture failed: ${String(err)}`);
    }
  }

  function emitCommandResult(requestId: string, result: { ok: boolean; result?: unknown; error?: string }): void {
    notifyEvent(`${COMMAND_RESULT_MARKER} ${JSON.stringify({ requestId, ...result })}`);
  }

  const success = (id: unknown, command: string, data?: unknown) => ({
    type: "response",
    id,
    command,
    success: true,
    ...(data !== undefined ? { data } : {}),
  });
  const failure = (id: unknown, command: string, error: string) => ({
    type: "response",
    id,
    command,
    success: false,
    error,
  });

  function clearCompactionIdleCheck(): void {
    if (compactionIdleCheck) clearTimeout(compactionIdleCheck);
    compactionIdleCheck = null;
  }

  function finishAborts(ctx: ExtensionContext, manualOnly = false, error?: string): void {
    if (!error && !ctx.isIdle()) return;
    for (const request of pendingAborts) {
      if (manualOnly && !request.manualCompaction) continue;
      pendingAborts.delete(request);
      if (request.socket === client && !request.socket.destroyed) {
        send(error ? failure(request.id, "abort", error) : success(request.id, "abort"));
      }
    }
    if (pendingAborts.size === 0) clearCompactionIdleCheck();
  }

  function waitForManualCompactionIdle(ctx: ExtensionContext): void {
    if (compactionIdleCheck || !manualCompaction) return;
    // Pi clears manual compaction's busy flag only AFTER all success hooks
    // return, with no later extension event. Do not poll agent/auto-compaction:
    // those must forward agent_settled before ACK, even if already idle.
    // Also clear completion state when no abort is pending, so it cannot be
    // mistaken for a later run that is busy before agent_start.
    const deadline = Date.now() + 5000;
    const check = () => {
      compactionIdleCheck = null;
      if (!manualCompaction) return;
      if (ctx.isIdle()) {
        manualCompaction = false;
        finishAborts(ctx, true);
      } else if (Date.now() >= deadline) {
        manualCompaction = false;
        finishAborts(ctx, true, "Timed out waiting for manual compaction to become idle");
      } else compactionIdleCheck = setTimeout(check, 25);
    };
    compactionIdleCheck = setTimeout(check, 25);
  }

  function handleAbort(id: unknown, socket: net.Socket): void {
    if (socket !== client || socket.destroyed) return;
    // ctx.abort() is void. Register before calling it, and never let another
    // abort ACK overtake the terminal boundary an earlier request is awaiting.
    const waitForBoundary = pendingAborts.size > 0 || (latestCtx && !latestCtx.isIdle());
    const request = { id, socket, manualCompaction };
    pendingAborts.add(request);
    try {
      latestCtx?.abort();
    } catch (err) {
      pendingAborts.delete(request);
      throw err;
    }
    if (!waitForBoundary) {
      pendingAborts.delete(request);
      send(success(id, "abort"));
    } else if (manualCompaction && !isCompacting && latestCtx) {
      waitForManualCompactionIdle(latestCtx);
    }
  }

  function buildState(): Record<string, unknown> {
    const ctx = latestCtx;
    const sm = ctx?.sessionManager;
    const messageCount = sm ? sm.getEntries().filter((e: any) => e.type === "message").length : 0;
    return {
      model: ctx?.model ?? null,
      thinkingLevel: pi.getThinkingLevel(),
      isStreaming: ctx ? !ctx.isIdle() : false,
      isCompacting,
      sessionFile: sm?.getSessionFile(),
      sessionId: sm?.getSessionId(),
      sessionName: sm?.getSessionName(),
      autoCompactionEnabled,
      messageCount,
      pendingMessageCount: ctx?.hasPendingMessages() ? 1 : 0,
      contextUsage: ctx?.getContextUsage(),
    };
  }

  function handlePrompt(cmd: any): void {
    const message: string = typeof cmd.message === "string" ? cmd.message : "";
    if (message.startsWith(`/${CAPTURE_COMMAND}`)) {
      const payload = decodeCommandPayload(message.slice(CAPTURE_COMMAND.length + 1));
      emitEntryCapture(latestCtx, "command", typeof payload?.requestId === "string" ? payload.requestId : undefined);
      send(success(cmd.id, "prompt"));
      return;
    }
    if (message.startsWith(`/${TREE_COMMAND}`)) {
      const payload = decodeCommandPayload(message.slice(TREE_COMMAND.length + 1));
      if (typeof payload?.requestId === "string") {
        emitCommandResult(payload.requestId, {
          ok: false,
          error: "Timeline rewind is not supported for terminal-attached pi sessions",
        });
      }
      send(success(cmd.id, "prompt"));
      return;
    }
    const content = Array.isArray(cmd.images) && cmd.images.length > 0
      ? [{ type: "text", text: message }, ...cmd.images]
      : message;
    const streaming = latestCtx ? !latestCtx.isIdle() : false;
    pi.sendUserMessage(content as any, { expandPromptTemplates: true, ...(streaming ? { deliverAs: "followUp" as const } : {}) });
    send(success(cmd.id, "prompt", { agentInvoked: true }));
  }

  async function handleCommand(cmd: any, socket: net.Socket): Promise<void> {
    const id = cmd.id;
    const type: string = cmd.type;
    try {
      switch (type) {
        case "prompt":
          handlePrompt(cmd);
          return;
        case "steer":
          pi.sendUserMessage(cmd.message, { deliverAs: "steer" });
          send(success(id, type));
          return;
        case "follow_up":
          pi.sendUserMessage(cmd.message, { deliverAs: "followUp" });
          send(success(id, type));
          return;
        case "abort":
          handleAbort(id, socket);
          return;
        case "get_state":
          send(success(id, type, buildState()));
          return;
        case "get_messages": {
          const messages = latestCtx?.sessionManager.buildSessionProjection().messages ?? [];
          send(success(id, type, { messages }));
          return;
        }
        case "get_available_models":
          send(success(id, type, { models: latestCtx?.modelRegistry.getAvailable() ?? [] }));
          return;
        case "set_model": {
          const model = latestCtx?.modelRegistry.find(cmd.provider, cmd.modelId);
          if (!model) {
            send(failure(id, type, `Model not found: ${cmd.provider}/${cmd.modelId}`));
            return;
          }
          remoteAppliedModel = modelToId(model);
          const ok = await pi.setModel(model);
          if (!ok) {
            send(failure(id, type, `No API key available for ${cmd.provider}/${cmd.modelId}`));
            return;
          }
          send(success(id, type, model));
          return;
        }
        case "set_thinking_level":
          remoteAppliedThinking = cmd.level;
          pi.setThinkingLevel(cmd.level);
          send(success(id, type));
          return;
        case "get_session_stats":
          send(success(id, type, { contextUsage: latestCtx?.getContextUsage() }));
          return;
        case "get_commands":
          send(success(id, type, { commands: pi.getCommands() }));
          return;
        case "compact":
          latestCtx?.compact(cmd.customInstructions ? { customInstructions: cmd.customInstructions } : undefined);
          send(success(id, type));
          return;
        case "set_auto_compaction":
          autoCompactionEnabled = Boolean(cmd.enabled);
          send(success(id, type));
          return;
        case "extension_ui_response":
          handleAskResponse(cmd, socket);
          return;
        default:
          // Paseo's compatibility fallbacks match Pi's exact unknown-command error.
          send(failure(id, type ?? "unknown", `Unknown command: ${type}`));
      }
    } catch (err) {
      debugLog(`command ${type} failed: ${String(err)}`);
      send(failure(id, type ?? "unknown", err instanceof Error ? err.message : String(err)));
    }
  }

  function attachClient(socket: net.Socket): void {
    client = socket;
    socket.setNoDelay?.(true);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          debugLog("ignoring non-JSON line from client");
          continue;
        }
        void handleCommand(parsed, socket);
      }
    });
    const detach = () => {
      dropAsks(socket);
      for (const request of pendingAborts) {
        if (request.socket === socket) pendingAborts.delete(request);
      }
      // Compaction belongs to Pi, not the controller; keep its idle watcher
      // across reconnects, without retaining the disconnected requests.
      if (client === socket) client = null;
      debugLog("client disconnected");
    };
    socket.on("close", detach);
    socket.on("error", (err) => {
      debugLog(`client socket error: ${String(err)}`);
      detach();
    });
    debugLog("client connected");
    notifyTui("Paseo attached to this session");
    // Prime Paseo's user-entry capture, mirroring what its injected
    // extension does on session_start.
    emitEntryCapture(latestCtx, "session_start");
  }

  function stopServer(): void {
    pendingAborts.clear();
    clearCompactionIdleCheck();
    isCompacting = false;
    manualCompaction = false;
    if (client) {
      dropAsks(client);
      try {
        client.destroy();
      } catch {
        // already gone
      }
      client = null;
    }
    if (server) {
      try {
        server.close();
      } catch {
        // already closed
      }
      server = null;
    }
    if (releaseOwner) {
      releaseOwner();
      releaseOwner = null;
    }
    currentSessionFile = null;
    currentAgentId = null;
    remoteAppliedModel = null;
    remoteAppliedThinking = null;
    titleAttempted = false;
  }

  function startServer(sessionFile: string): void {
    const paths = sessionPaths(sessionFile);
    const release = claimOwner(paths, "terminal");
    const pipePath = paths.socket;
    const srv = net.createServer((socket) => {
      if (client) {
        try {
          socket.write(
            `${JSON.stringify({
              type: "response",
              id: null,
              command: "connect",
              success: false,
              error: "pi-paseo-bridge: another controller is already attached to this session",
            })}\n`,
          );
        } catch {
          // best effort
        }
        socket.destroy();
        return;
      }
      attachClient(socket);
    });
    srv.on("error", () => {
      debugLog("bridge server failed");
      stopServer();
    });
    srv.listen(pipePath, () => {
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(pipePath, 0o600);
        } catch {
          debugLog("bridge socket permissions failed");
          stopServer();
          return;
        }
      }
      registerWithPaseo(sessionFile, latestCtx?.cwd ?? process.cwd());
      debugLog(`listening on ${pipePath} for ${sessionFile}`);
    });
    server = srv;
    releaseOwner = release;
    currentSessionFile = sessionFile;
  }

  const agentMapFile = path.join(os.homedir(), ".pi", "paseo-bridge", "agents.json");

  function agentMapKey(sessionFile: string): string {
    const resolved = canonicalSession(sessionFile);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  function readAgentMap(): Record<string, string> {
    try {
      const parsed = JSON.parse(fs.readFileSync(agentMapFile, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeAgentMapEntry(sessionFile: string, agentId: string): void {
    try {
      fs.mkdirSync(path.dirname(agentMapFile), { recursive: true });
      const map = readAgentMap();
      map[agentMapKey(sessionFile)] = agentId;
      fs.writeFileSync(agentMapFile, `${JSON.stringify(map, null, 2)}\n`);
    } catch (err) {
      debugLog(`could not persist agent map: ${String(err)}`);
    }
  }

  function adoptAgent(agentId: string, reused: boolean): void {
    currentAgentId = agentId;
    debugLog(`paseo agent id: ${agentId}${reused ? " (reused)" : ""}`);
    // Align Paseo's cached model/thinking with the TUI's live values. The
    // import-time descriptor scan can be stale or empty.
    pushAgentConfigToPaseo("model", modelToId(latestCtx?.model));
    pushAgentConfigToPaseo("thinking", pi.getThinkingLevel() ?? null);
    notifyTui(reused ? "Session reconnected in Paseo" : "Session imported into Paseo");
    // Resumed sessions already have history (and possibly a name); sync the
    // title now instead of waiting for the next turn.
    if (latestCtx) void maybeGenerateSessionTitle(latestCtx);
  }

  function registerWithPaseo(sessionFile: string, cwd: string): void {
    if (process.env.PI_PASEO_BRIDGE_NO_IMPORT) return;
    if (importAttempted.has(sessionFile)) return;
    importAttempted.add(sessionFile);
    const cli = resolvePaseoCli();
    if (!cli) {
      debugLog("paseo CLI not found; session will not auto-appear (set PASEO_CLI)");
      return;
    }
    const hostArgs = process.env.PASEO_HOST ? ["--host", process.env.PASEO_HOST] : [];
    const runImport = () => {
      const args = ["import", "--provider", "pi", sessionFile, "--cwd", cwd, "--json", ...hostArgs];
      runPaseoCli(cli, args, (code, output) => {
        debugLog(`paseo import exited ${code}`);
        if (code !== 0) return;
        try {
          const jsonStart = output.indexOf("{");
          if (jsonStart === -1) return;
          const result = JSON.parse(output.slice(jsonStart));
          if (typeof result.agentId === "string" && result.agentId) {
            writeAgentMapEntry(sessionFile, result.agentId);
            adoptAgent(result.agentId, false);
          }
        } catch (err) {
          debugLog(`could not parse import output: ${String(err)}`);
        }
      });
    };
    // Re-importing a session Paseo already knows creates a duplicate agent,
    // so check the last known agent for this session file first.
    const knownAgentId = readAgentMap()[agentMapKey(sessionFile)];
    if (!knownAgentId) {
      runImport();
      return;
    }
    runPaseoCli(cli, ["inspect", knownAgentId, "--json", ...hostArgs], (code, output) => {
      let exists = false;
      try {
        if (code === 0) {
          const jsonStart = output.indexOf("{");
          const info = jsonStart === -1 ? null : JSON.parse(output.slice(jsonStart));
          exists = Boolean(info) && info.Archived !== true;
        }
      } catch (err) {
        debugLog(`inspect of known agent failed: ${String(err)}`);
      }
      if (!exists) {
        runImport();
        return;
      }
      // The daemon's provider session for this agent died with the previous
      // TUI process; reload restarts it so it reattaches to the new pipe.
      runPaseoCli(cli, ["agent", "reload", knownAgentId, "--json", ...hostArgs], (reloadCode) => {
        debugLog(`paseo agent reload exited ${reloadCode}`);
        if (reloadCode === 0) {
          adoptAgent(knownAgentId, true);
        } else {
          runImport();
        }
      });
    });
  }

  function connectSession(ctx: ExtensionContext): string {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return "This session is ephemeral (--no-session); nothing to bridge.";
    if (file !== currentSessionFile) {
      stopServer();
      startServer(file);
    }
    importAttempted.delete(file);
    if (server?.listening) registerWithPaseo(file, ctx.cwd);
    return "Connecting session to Paseo...";
  }

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    try {
      const force = ["1", "true", "on"].includes((process.env.PI_PASEO_BRIDGE_FORCE ?? "").toLowerCase());
      if (ctx.mode !== "tui" && !force) return;
      if (!isAutoEnabled()) return;
      connectSession(ctx);
    } catch (err) {
      debugLog(`session_start failed: ${String(err)}`);
    }
  });

  pi.on("session_shutdown", async () => {
    stopServer();
  });

  const forwardEvents = [
    "agent_start",
    "turn_start",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "agent_end",
    "agent_settled",
  ] as const;
  for (const eventName of forwardEvents) {
    (pi as any).on(eventName, async (event: unknown, ctx: ExtensionContext) => {
      latestCtx = ctx;
      if (eventName === "agent_start") {
        manualCompaction = false;
        clearCompactionIdleCheck();
      }
      // Extension agent_end omits runtime willRetry. Its presence opts Paseo
      // into waiting for agent_settled, including retries and queued continuations.
      send(eventName === "agent_end" ? { ...(event as object), willRetry: false } : event);
      // Paseo must consume the old run's terminal before an abort ACK lets it
      // open a replacement turn. Settled handlers may then queue a new run.
      if (eventName === "agent_settled") finishAborts(ctx);
    });
  }

  // Imported terminal sessions have no title in Paseo (the UI falls back to
  // the branch name), so generate one from the first user message.
  async function maybeGenerateSessionTitle(ctx: ExtensionContext): Promise<void> {
    if (titleAttempted || !currentAgentId) return;
    if (process.env.PI_PASEO_BRIDGE_NO_TITLE) return;
    const existingName = ctx.sessionManager.getSessionName();
    if (existingName) {
      // Session already named (by the user or a previous run) - just make
      // sure Paseo shows it.
      titleAttempted = true;
      const agentId = currentAgentId;
      syncPaseo((conn) => conn.updateAgent(agentId, { name: existingName }));
      void setPaseoWorkspaceTitle(agentId, existingName);
      return;
    }
    const firstMessage = capturedUserEntries(ctx)[0]?.text?.trim();
    if (!firstMessage) {
      debugLog("title generation: no user message in session yet");
      return;
    }
    titleAttempted = true;
    try {
      const model = ctx.model;
      if (!model) return;
      const response = await ctx.modelRegistry.complete(
        model,
        {
          systemPrompt:
            "You name coding agent sessions. Given the user's first message, reply with only a short session title: 3 to 8 words, plain text, no quotes, no trailing punctuation.",
          messages: [
            { role: "user", content: [{ type: "text", text: firstMessage.slice(0, 4000) }], timestamp: Date.now() } as any,
          ],
        },
        { maxTokens: 1024, reasoning: "off" },
      );
      let title = readTextContent(response.content).trim().split("\n")[0].trim().replace(/^["']+|["']+$/g, "");
      if (!title) {
        debugLog(`title generation: empty response (stopReason=${(response as any).stopReason})`);
        return;
      }
      if (title.length > 80) title = `${title.slice(0, 77)}...`;
      pi.setSessionName(title);
      const agentId = currentAgentId;
      if (agentId) syncPaseo((conn) => conn.updateAgent(agentId, { name: title }));
      if (agentId) void setPaseoWorkspaceTitle(agentId, title);
    } catch (err) {
      debugLog(`title generation failed: ${String(err)}`);
    }
  }

  pi.on("turn_start", async (_event, ctx) => {
    void maybeGenerateSessionTitle(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    latestCtx = ctx;
    send(event);
    emitEntryCapture(ctx, "turn_end");
    void maybeGenerateSessionTitle(ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    latestCtx = ctx;
    manualCompaction = (event as any).reason === "manual";
    if (!manualCompaction) clearCompactionIdleCheck();
    isCompacting = true;
    send({ type: "compaction_start" });
    return undefined;
  });

  function compactionFinished(event: any, ctx: ExtensionContext): void {
    latestCtx = ctx;
    isCompacting = false;
    send({
      type: "compaction_end",
      ...(event?.entry ? { entry: event.entry } : {}),
      ...(event?.type === "session_compact_failed" ? { aborted: event.aborted, errorMessage: event.errorMessage } : {}),
    });
    if (manualCompaction) waitForManualCompactionIdle(ctx);
  }
  pi.on("session_compact", compactionFinished);
  (pi as any).on("session_compact_failed", compactionFinished);

  pi.on("model_select", async (event, ctx) => {
    latestCtx = ctx;
    const modelId = modelToId(event.model);
    if (modelId === remoteAppliedModel) {
      remoteAppliedModel = null;
      return;
    }
    pushAgentConfigToPaseo("model", modelId);
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    latestCtx = ctx;
    if (event.level === remoteAppliedThinking) {
      remoteAppliedThinking = null;
      return;
    }
    pushAgentConfigToPaseo("thinking", event.level ?? null);
  });

  pi.registerCommand("paseo-bridge", {
    description: "Manage the Paseo bridge: install | uninstall | auto [on|off] | connect | disconnect | status",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "status";
      try {
        switch (sub) {
          case "install": {
            const result = installShimIntoPaseoConfig();
            ctx.ui.notify(result.message, result.ok ? "info" : "error");
            return;
          }
          case "uninstall": {
            const result = uninstallShimFromPaseoConfig();
            ctx.ui.notify(result.message, result.ok ? "info" : "error");
            return;
          }
          case "auto": {
            const value = parts[1]?.toLowerCase();
            if (value !== "on" && value !== "off") {
              ctx.ui.notify(`Auto-connect is ${isAutoEnabled() ? "on" : "off"}. Use /paseo-bridge auto on|off to change.`, "info");
              return;
            }
            writeBridgeSettings({ auto: value === "on" });
            ctx.ui.notify(`Auto-connect ${value}: new TUI sessions will ${value === "on" ? "" : "not "}appear in Paseo automatically.`, "info");
            return;
          }
          case "connect":
            ctx.ui.notify(connectSession(ctx), "info");
            return;
          case "disconnect":
            if (!server) {
              ctx.ui.notify("Bridge is not connected.", "info");
              return;
            }
            stopServer();
            ctx.ui.notify("Bridge disconnected. Use /paseo-bridge connect to reattach.", "info");
            return;
          case "status": {
            let shimInstalled = false;
            try {
              shimInstalled = isOurShimCommand(
                JSON.parse(fs.readFileSync(paseoConfigFile, "utf8"))?.agents?.providers?.pi?.command,
              );
            } catch {
              // unreadable config counts as not installed
            }
            const lines = [
              `shim: ${shimInstalled ? "installed" : "not installed (run /paseo-bridge install)"}`,
              `auto-connect: ${isAutoEnabled() ? "on" : "off"}`,
              `session: ${server ? (currentAgentId ? `bridged as Paseo agent ${currentAgentId}` : "bridged (not yet imported)") : "not bridged"}`,
            ];
            ctx.ui.notify(`Paseo bridge status\n${lines.join("\n")}`, "info");
            return;
          }
          default:
            ctx.ui.notify("Usage: /paseo-bridge install | uninstall | auto [on|off] | connect | disconnect | status", "warning");
        }
      } catch (err) {
        ctx.ui.notify(`paseo-bridge: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
