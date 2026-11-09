import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
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

test("extension forwards settled boundaries/abort and native compacted edited projection over a real socket", async (t) => {
  const { file, paths } = fixture("extension");
  const handlers = new Map();
  const prompts = [];
  const pi = {
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
  const ctx = {
    mode: "tui", cwd: root, isIdle: () => true, ui: { notify() {} },
    sessionManager: new Proxy(manager, { get(target, key) { return key === "getSessionFile" ? () => file : typeof target[key] === "function" ? target[key].bind(target) : target[key]; } }),
  };
  const emit = async (name, event) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
  await emit("session_start", {});
  const socket = net.connect(paths.socket);
  const next = lines(socket);
  await once(socket, "connect");
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
  socket.destroy();
  await once(socket, "close");
  const attached = spawn(process.execPath, [shim, "--session", file], {
    env: { ...process.env, PI_REAL_BIN: fakePi }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => attached.kill());
  attached.stderr.resume();
  const bridgeNext = lines(attached.stdout);
  attached.stdin.write(JSON.stringify({ type: "get_messages", id: "via-shim" }) + "\n");
  assert.equal((await bridgeNext((line) => line.id === "via-shim")).success, true);
  await emit("session_shutdown", {});
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
