import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHostClient, parseHostTarget } from "@getpaseo/client/node";
import { normalizeLoopbackToLocalhost, parseConnectionUri } from "@getpaseo/protocol/daemon-endpoints";

export function paseoHome() {
  return path.resolve(process.env.PASEO_HOME || path.join(os.homedir(), ".paseo"));
}

function instanceTarget(home) {
  try {
    const instance = JSON.parse(fs.readFileSync(path.join(home, "paseo.pid"), "utf8"));
    return typeof instance.listen === "string" ? instance.listen : null;
  } catch {
    return null;
  }
}

// Match the native local-credential target rules. Never export a home's token
// to an unrelated host, including a different local port/forwarder.
function normalizeTarget(target) {
  try {
    const value = target.trim();
    if (value.startsWith("tcp://")) {
      const parsed = parseConnectionUri(value);
      return normalizeLoopbackToLocalhost(`${parsed.isIpv6 ? `[${parsed.host}]` : parsed.host}:${parsed.port}`);
    }
    if (value.startsWith("unix://") || value.startsWith("pipe://")) return value;
    if (value.startsWith("/")) return `unix://${value}`;
    if (value.startsWith("\\\\.\\pipe\\")) return `pipe://${value}`;
    if (/^\d+$/.test(value)) return `localhost:${value}`;
    return normalizeLoopbackToLocalhost(value);
  } catch {
    return null;
  }
}

export function readLocalCredentialForTarget(home, target) {
  const listening = instanceTarget(home);
  if (!listening || !normalizeTarget(target) || normalizeTarget(target) !== normalizeTarget(listening)) return undefined;
  try {
    const token = fs.readFileSync(path.join(home, "local-credential"), "utf8").trim();
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

export function openPaseoClient() {
  const home = paseoHome();
  const target = process.env.PASEO_HOST?.trim() || instanceTarget(home);
  if (!target) throw new Error("Selected Paseo instance is not ready");
  const password = parseHostTarget(target).password || process.env.PASEO_PASSWORD || undefined;
  return createHostClient(target, {
    clientId: `pi-paseo-bridge-${process.pid}`,
    clientType: "cli",
    appVersion: "0.15.3",
    ...(password ? { password } : { localCredential: () => readLocalCredentialForTarget(home, target) }),
    connectTimeoutMs: 5000,
    reconnect: { enabled: false },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}
