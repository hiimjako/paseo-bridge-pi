import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { sessionPaths, claimOwner, readOwner } from "../shim/session-owner.js";

const root = fs.mkdtempSync("/tmp/paseo-bridge-test-");
const originalHome = process.env.HOME;
process.env.HOME = root;
process.env.PASEO_HOME = path.join(root, "paseo");
delete process.env.PASEO_HOST;
delete process.env.PASEO_PASSWORD;
process.env.PI_PASEO_BRIDGE_NO_IMPORT = "1";
process.env.PI_PASEO_BRIDGE_NO_TITLE = "1";
fs.mkdirSync(process.env.PASEO_HOME, { mode: 0o700 });
const { default: extension } = await import("../extension/index.ts");
const { openPaseoClient, readLocalCredentialForTarget } = await import("../extension/paseo-client.js");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const require = createRequire(import.meta.url);
const { WebSocketServer } = require(require.resolve("ws", { paths: [path.dirname(require.resolve("@getpaseo/client/node"))] }));
const shim = path.resolve("shim/pi-paseo-shim.js");
const fakePi = path.join(root, "fake-pi.mjs");
fs.writeFileSync(fakePi, 'process.stdout.write("NATIVE " + JSON.stringify(process.argv.slice(2)) + "\\n");');
const createdPaths = [];

function fixture(name) {
  const file = path.join(root, `${name}.jsonl`);
  fs.writeFileSync(file, "");
  const paths = sessionPaths(file);
  createdPaths.push(paths);
  return { file, paths };
}
async function runShim(args) {
  const child = spawn(process.execPath, [shim, ...args], { env: { ...process.env, PI_REAL_BIN: fakePi }, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => output += data);
  child.stderr.on("data", () => {});
  child.stdin.end();
  const [code] = await once(child, "exit");
  return { code, output };
}
function lines(socket) {
  const queue = [];
  let buffer = "";
  socket.on("data", (data) => {
    buffer += data;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      queue.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  return async (predicate) => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return queue.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("RPC response timeout");
  };
}

test.after(() => {
  for (const paths of createdPaths) {
    fs.rmSync(paths.directory, { recursive: true, force: true });
    fs.rmSync(paths.socket, { force: true });
  }
  fs.rmSync(root, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

test("shim fails closed for live/missing/ambiguous terminal ownership and preserves native fallback", async () => {
  const live = fixture("live");
  const release = claimOwner(live.paths, "terminal");
  assert.throws(() => claimOwner(live.paths, "terminal"));
  const terminalSocket = net.createServer();
  terminalSocket.listen(live.paths.socket);
  await once(terminalSocket, "listening");
  assert.ok(fs.existsSync(live.paths.socket));
  await new Promise((resolve) => terminalSocket.close(resolve));
  assert.equal(fs.existsSync(live.paths.socket), false);
  assert.equal((await runShim(["--session", live.file])).code, 1);
  release();
  // Runtime socket cleanup must not erase persistent terminal adoption.
  fs.rmSync(live.paths.socket, { force: true });
  assert.equal(readOwner(live.paths).kind, "terminal");
  assert.equal((await runShim(["--session", live.file])).code, 1);
  const reopened = claimOwner(live.paths, "terminal");
  reopened();

  const unknown = fixture("unknown");
  fs.mkdirSync(unknown.paths.directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(unknown.paths.directory, "owner.json"), "broken", { mode: 0o600 });
  assert.equal((await runShim(["--session", unknown.file])).code, 1);

  const missingRecord = fixture("missing-record");
  fs.mkdirSync(missingRecord.paths.directory, { recursive: true, mode: 0o700 });
  assert.equal((await runShim(["--session", missingRecord.file])).code, 1);

  const socketOnly = fixture("unknown-socket");
  fs.mkdirSync(socketOnly.paths.directory, { recursive: true, mode: 0o700 });
  const server = net.createServer();
  server.listen(socketOnly.paths.socket);
  await once(server, "listening");
  assert.equal((await runShim(["--session", socketOnly.file])).code, 1);
  assert.ok(fs.existsSync(socketOnly.paths.socket));
  await new Promise((resolve) => server.close(resolve));

  const native = fixture("native");
  const result = await runShim(["--session", native.file, "--mode", "rpc"]);
  assert.equal(result.code, 0);
  assert.match(result.output, /NATIVE/);
  assert.equal(readOwner(native.paths).pid, null);
  assert.equal((await runShim(["--session", native.file])).code, 0);
  assert.equal((await runShim(["--mode", "rpc"])).code, 0);
});

test("positive dead-owner recovery and canonical symlink rendezvous", async () => {
  const { file, paths } = fixture("dead");
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  await once(child, "exit");
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths.directory, "owner.json"), JSON.stringify({ kind: "terminal", pid }), { mode: 0o600 });
  assert.equal((await runShim(["--session", file])).code, 1);
  const release = claimOwner(paths, "terminal");
  release();
  const alias = path.join(root, "alias.jsonl");
  fs.symlinkSync(file, alias);
  assert.deepEqual(sessionPaths(alias), paths);
});

test("extension forwards ask_user dialogs, settled boundaries and edited projection over a real socket", async (t) => {
  const { file, paths } = fixture("extension");
  const handlers = new Map();
  const prompts = [];
  const events = new EventEmitter();
  const pi = {
    events,
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand() {},
    sendUserMessage(...args) { prompts.push(args); },
    getThinkingLevel() { return "off"; },
  };
  extension(pi);
  const manager = SessionManager.inMemory(root);
  manager.appendMessage({ role: "user", content: "old history", timestamp: 1 });
  const kept = manager.appendMessage({ role: "user", content: "original", timestamp: 2 });
  manager.appendCompaction("preserved summary", kept, 100);
  manager.appendContextEdit(kept, { content: "edited" });
  manager.branchWithSummary(manager.getLeafId(), "active branch summary");
  let abortCalls = 0;
  const ctx = {
    mode: "tui", cwd: root, isIdle: () => true, ui: { notify() {} },
    abort() { abortCalls++; },
    sessionManager: new Proxy(manager, { get(target, key) { return key === "getSessionFile" ? () => file : typeof target[key] === "function" ? target[key].bind(target) : target[key]; } }),
  };
  const emit = async (name, event) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  // Synthetic import + authenticated daemon endpoint; never attach a real session.
  const daemon = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(daemon, "listening");
  const target = `127.0.0.1:${daemon.address().port}`;
  const token = randomBytes(32).toString("base64url");
  fs.writeFileSync(path.join(process.env.PASEO_HOME, "paseo.pid"), JSON.stringify({ listen: target }));
  fs.writeFileSync(path.join(process.env.PASEO_HOME, "local-credential"), token);
  const cleanup = [];
  daemon.on("connection", (ws) => ws.on("message", (data) => {
    const frame = JSON.parse(String(data));
    if (frame.type === "hello") {
      assert.equal(frame.auth.token, token);
      ws.send(JSON.stringify({ type: "session", message: { type: "status", payload: { status: "server_info", serverId: "test-daemon" } } }));
      return;
    }
    const message = frame.message;
    if (message?.type === "agent_permission_response") {
      cleanup.push(message);
      ws.send(JSON.stringify({ type: "session", message: { type: "agent_permission_resolved", payload: {
        agentId: message.agentId, requestId: message.requestId, resolution: message.response,
      } } }));
    } else if (message?.requestId) {
      ws.send(JSON.stringify({ type: "session", message: { type: "rpc_error", payload: {
        requestId: message.requestId, error: "synthetic unsupported operation",
      } } }));
    }
  }));
  t.after(async () => {
    for (const ws of daemon.clients) ws.terminate();
    await new Promise((resolve) => daemon.close(resolve));
    process.env.PI_PASEO_BRIDGE_NO_IMPORT = "1";
    delete process.env.PASEO_CLI;
  });
  const cli = path.join(root, "fake-paseo");
  fs.writeFileSync(cli, `#!${process.execPath}\nconsole.log('{"agentId":"test-agent"}')\n`, { mode: 0o700 });
  process.env.PASEO_CLI = cli;
  delete process.env.PI_PASEO_BRIDGE_NO_IMPORT;
  let adopted;
  const imported = new Promise((resolve) => { adopted = resolve; });
  ctx.ui.notify = (message) => { if (message === "Session imported into Paseo") adopted(); };
  await emit("session_start", {});
  await imported;
  const socket = net.connect(paths.socket);
  const next = lines(socket);
  await once(socket, "connect");
  await next((line) => line.method === "notify"); // server has attached the controller
  const answers = [];
  const ask = (id) => {
    const controller = new AbortController();
    events.emit("ask-user:request", {
      id, question: "Synthetic question", options: [
        { label: "Same", description: "first" }, { label: "Same", description: "second" },
      ], signal: controller.signal, respond: (response) => answers.push([id, response]),
    });
    return controller;
  };
  const reply = (id, fields) => socket.write(JSON.stringify({ type: "extension_ui_response", id, ...fields }) + "\n");
  const barrier = async () => {
    socket.write(JSON.stringify({ type: "get_state", id: "barrier" }) + "\n");
    await next((line) => line.id === "barrier");
  };
  for (const custom of [false, true]) {
    ask(`remote-${custom}`);
    const select = await next((line) => line.method === "select");
    assert.deepEqual(select.options, ["1. Same — first", "2. Same — second", "3. Write my own answer…"]);
    reply("unknown", { value: select.options[0] });
    reply(select.id, { value: 1 });
    reply(select.id, { value: "Same" });
    await barrier();
    assert.equal(answers.length, custom ? 1 : 0);
    reply(select.id, { value: select.options[custom ? 2 : 1] });
    if (custom) {
      const input = await next((line) => line.method === "input");
      assert.notEqual(input.id, select.id);
      reply(select.id, { cancelled: true });
      reply(input.id, { value: "  custom text  " });
      reply(input.id, { value: "duplicate" });
    } else {
      reply(select.id, { value: select.options[0] });
    }
    await barrier();
  }
  assert.deepEqual(answers, [["remote-false", { index: 2 }], ["remote-true", { text: "custom text" }]]);
  ask("remote-cancel");
  reply((await next((line) => line.method === "select")).id, { cancelled: true });
  await barrier();
  assert.deepEqual(answers.at(-1), ["remote-cancel", null]);
  const waitCleanup = async (id) => {
    const deadline = Date.now() + 2000;
    while (!cleanup.some((message) => message.requestId === id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const message = cleanup.find((message) => message.requestId === id);
    assert.ok(message, "native cleanup received");
    assert.equal(message.agentId, "test-agent");
    return message.response;
  };
  for (const response of [{ index: 2 }, { text: "local custom" }, null]) {
    const controller = ask("local");
    const select = await next((line) => line.method === "select");
    events.emit("ask-user:resolved", { id: "local", response });
    controller.abort();
    reply(select.id, { value: select.options[0] });
    assert.deepEqual(await waitCleanup(select.id), response === null ? { behavior: "deny" } : {
      behavior: "allow", updatedInput: { answers: { Response: select.options["index" in response ? 1 : 2] } },
    });
  }
  const aborted = ask("abort");
  const abortCard = await next((line) => line.method === "select");
  aborted.abort();
  assert.deepEqual(await waitCleanup(abortCard.id), { behavior: "deny" });
  await barrier();
  assert.equal(answers.length, 3);
  await emit("agent_end", { type: "agent_end", messages: [] });
  assert.equal((await next((line) => line.type === "agent_end")).willRetry, false);
  // Paseo's documented compatibility boundary only completes agent_end with
  // undefined willRetry. Retries/continuations must therefore remain active.
  await emit("agent_start", { type: "agent_start" });
  await emit("agent_end", { type: "agent_end", messages: [] });
  assert.notEqual((await next((line) => line.type === "agent_end")).willRetry, undefined);
  await emit("agent_settled", { type: "agent_settled", aborted: true });
  assert.equal((await next((line) => line.type === "agent_settled")).aborted, true);
  socket.write(JSON.stringify({ type: "get_messages", id: "history" }) + "\n");
  const response = await next((line) => line.id === "history");
  assert.deepEqual(response.data.messages, manager.buildSessionProjection().messages);
  assert.ok(response.data.messages.some((message) => message.role === "compactionSummary"));
  assert.ok(response.data.messages.some((message) => message.role === "branchSummary"));
  assert.ok(response.data.messages.some((message) => message.content === "edited"));
  socket.write(JSON.stringify({ type: "prompt", id: "slash", message: "/example" }) + "\n");
  await next((line) => line.id === "slash");
  assert.equal(prompts[0][1].expandPromptTemplates, true);
  await t.test("unsupported clear_queue allows Paseo's compatibility fallback to abort", async () => {
    socket.write(JSON.stringify({ type: "clear_queue", id: "clear-before-abort" }) + "\n");
    const cleared = await next((line) => line.id === "clear-before-abort");
    // Paseo matches this exact Pi RPC error before continuing with abort.
    assert.deepEqual(cleared, {
      type: "response", id: "clear-before-abort", command: "clear_queue",
      success: false, error: "Unknown command: clear_queue",
    });
    assert.equal(abortCalls, 0);
    socket.write(JSON.stringify({ type: "abort", id: "abort-after-clear" }) + "\n");
    assert.deepEqual(await next((line) => line.id === "abort-after-clear"), {
      type: "response", id: "abort-after-clear", command: "abort", success: true,
    });
    assert.equal(abortCalls, 1);
  });
  ask("disconnect");
  const disconnectedCard = await next((line) => line.method === "select");
  socket.destroy();
  await once(socket, "close");
  assert.deepEqual(await waitCleanup(disconnectedCard.id), { behavior: "deny" });
  events.emit("ask-user:resolved", { id: "disconnect", response: { index: 1 } });
  ask("unattached");
  assert.equal(answers.length, 3); // disconnect never dismisses the PC contender
  const attached = spawn(process.execPath, [shim, "--session", file], {
    env: { ...process.env, PI_REAL_BIN: fakePi }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => attached.kill());
  attached.stderr.resume();
  const bridgeNext = lines(attached.stdout);
  attached.stdin.write(JSON.stringify({ type: "get_messages", id: "via-shim" }) + "\n");
  assert.equal((await bridgeNext((line) => line.id === "via-shim")).success, true);
  ask("shutdown");
  const shutdownCard = await bridgeNext((line) => line.method === "select");
  attached.stdin.write(JSON.stringify({ type: "extension_ui_response", id: disconnectedCard.id, value: disconnectedCard.options[0] }) + "\n");
  await emit("session_shutdown", {});
  assert.deepEqual(await waitCleanup(shutdownCard.id), { behavior: "deny" });
  assert.equal(answers.length, 3);
  assert.match((await bridgeNext((line) => line.type === "process_exit")).error, /terminal pi session has ended/);
  attached.stdin.write(JSON.stringify({ type: "prompt", id: "after-close", message: "do not run" }) + "\n");
  assert.equal((await bridgeNext((line) => line.id === "after-close")).success, false);
  const exited = once(attached, "exit");
  attached.stdin.end();
  await exited;
  assert.equal((await runShim(["--session", file])).code, 1);
  await emit("session_start", {});
  await emit("session_shutdown", {});
});

test("supported client authenticates using matching fresh credentials and refuses absent auth", async () => {
  const home = process.env.PASEO_HOME;
  let token = randomBytes(32).toString("base64url");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const target = `127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(home, "paseo.pid"), JSON.stringify({ listen: target }));
  server.on("connection", (socket) => socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.type !== "hello") return;
    if (message.auth?.kind !== "localCredential" || message.auth.token !== token) {
      socket.send(JSON.stringify({ type: "hello.rejected", reason: "password_required" }));
      socket.close(1008, "Password required");
    } else {
      socket.send(JSON.stringify({ type: "session", message: { type: "status", payload: { status: "server_info", serverId: "test-daemon" } } }));
    }
  }));
  const missing = openPaseoClient();
  await assert.rejects(missing.connect());
  await missing.close();
  fs.writeFileSync(path.join(home, "local-credential"), `${token}\n`);
  assert.equal(readLocalCredentialForTarget(home, "other.example:6767"), undefined);
  assert.equal(readLocalCredentialForTarget(home, `127.0.0.1:${server.address().port + 1}`), undefined);
  const authenticated = openPaseoClient();
  // Callback must read the rotated token at connection time, not construction.
  token = randomBytes(32).toString("base64url");
  fs.writeFileSync(path.join(home, "local-credential"), `${token}\n`);
  await authenticated.connect();
  await authenticated.close();
  for (const socket of server.clients) socket.terminate();
  await new Promise((resolve) => server.close(resolve));
});
