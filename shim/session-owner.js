import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// HOME and XDG_RUNTIME_DIR can differ between the daemon and terminal.
export function runtimeDirectory() {
  const user = os.userInfo();
  return process.platform === "win32"
    ? path.join(user.homedir, ".pi", "paseo-bridge", "runtime")
    : path.join("/tmp", `pi-paseo-${user.uid}`);
}

export function canonicalSession(sessionFile) {
  const resolved = path.resolve(sessionFile);
  try {
    return fs.realpathSync(resolved);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  }
}

export function sessionPaths(sessionFile) {
  let canonical = canonicalSession(sessionFile);
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 20);
  const directory = path.join(path.dirname(canonical), ".paseo-bridge", hash);
  return {
    directory,
    socket: process.platform === "win32" ? `\\\\.\\pipe\\pi-paseo-bridge-${hash}` : path.join(runtimeDirectory(), `${hash}.sock`),
  };
}

export function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
    throw new Error("Bridge runtime directory must be private and owned by this user");
  }
}

export function readOwner(paths) {
  try {
    for (const directory of [path.dirname(paths.directory), paths.directory]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
        throw new Error("Unsafe bridge ownership directory");
      }
    }
    const ownerFile = path.join(paths.directory, "owner.json");
    const stat = fs.lstatSync(ownerFile);
    if (!stat.isFile() || stat.isSymbolicLink() ||
        (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
      throw new Error("Unsafe bridge ownership record");
    }
    const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
    if (!["terminal", "native"].includes(owner.kind) ||
        !(owner.pid === null || (Number.isInteger(owner.pid) && owner.pid > 0))) throw new Error("Invalid bridge owner");
    return owner;
  } catch (error) {
    if (error.code === "ENOENT" && !fs.existsSync(paths.directory)) return null;
    throw error;
  }
}

export function ownerIsDead(owner) {
  if (owner.pid === null) return true;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

// A short exclusive guard serializes claim/release, including dead-owner recovery.
// An interrupted guard is ambiguous and deliberately requires manual attention.
export function claimOwner(paths, kind) {
  privateDirectory(path.dirname(paths.directory));
  let created = false;
  try {
    fs.mkdirSync(paths.directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    privateDirectory(paths.directory);
  }
  if (process.platform !== "win32") privateDirectory(path.dirname(paths.socket));
  const guard = path.join(paths.directory, "guard");
  fs.mkdirSync(guard, { mode: 0o700 });
  let record;
  try {
    const previous = created ? null : readOwner(paths);
    if (previous && (!ownerIsDead(previous) || (kind === "native" && previous.kind === "terminal"))) {
      throw new Error("Session already owned or terminal-adopted; reopen its TUI explicitly");
    }
    if (!previous && process.platform !== "win32" && fs.existsSync(paths.socket)) {
      throw new Error("Socket has no established owner; refusing takeover");
    }
    if (previous && process.platform !== "win32") {
      try { fs.unlinkSync(paths.socket); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    record = { kind, pid: process.pid, nonce: crypto.randomUUID() };
    fs.writeFileSync(path.join(paths.directory, "owner.json"), JSON.stringify(record), { mode: 0o600 });
  } finally {
    fs.rmdirSync(guard);
  }
  const release = () => {
    fs.mkdirSync(guard, { mode: 0o700 });
    try {
      if (readOwner(paths)?.nonce !== record.nonce) throw new Error("Bridge ownership changed");
      if (process.platform !== "win32") {
        try { fs.unlinkSync(paths.socket); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      fs.writeFileSync(path.join(paths.directory, "owner.json"), JSON.stringify({ ...record, pid: null }), { mode: 0o600 });
    } finally {
      fs.rmdirSync(guard);
    }
  };
  release.setPid = (pid) => {
    fs.mkdirSync(guard, { mode: 0o700 });
    try {
      if (readOwner(paths)?.nonce !== record.nonce) throw new Error("Bridge ownership changed");
      record.pid = pid;
      fs.writeFileSync(path.join(paths.directory, "owner.json"), JSON.stringify(record), { mode: 0o600 });
    } finally {
      fs.rmdirSync(guard);
    }
  };
  return release;
}
