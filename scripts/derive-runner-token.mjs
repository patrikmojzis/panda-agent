#!/usr/bin/env node

import {createHmac} from "node:crypto";
import {lstatSync, readFileSync} from "node:fs";
import path from "node:path";

const [masterKeyFile, kind, agentKey, scopeId] = process.argv.slice(2);
if (!masterKeyFile || !kind || !agentKey || !scopeId) {
  throw new Error("Usage: derive-runner-token.mjs <master-key-file> <scope-kind> <agent-key> <scope-id>");
}
if (kind !== "persistent-agent" && kind !== "execution-environment") {
  throw new Error("Runner auth scope kind must be persistent-agent or execution-environment.");
}
if (!path.isAbsolute(masterKeyFile)) {
  throw new Error("Runner token master key file must be an absolute path.");
}
const file = lstatSync(masterKeyFile);
if (!file.isFile() || file.isSymbolicLink()) {
  throw new Error("Runner token master key path must be a regular file, not a symlink.");
}
if (process.platform !== "win32" && (file.mode & 0o077) !== 0) {
  throw new Error("Runner token master key file must not be accessible by group or other users (use chmod 600).");
}
const raw = readFileSync(masterKeyFile, "utf8").trim();
const encoded = raw.startsWith("base64:") ? raw.slice("base64:".length) : null;
const masterKey = encoded === null ? Buffer.from(raw, "utf8") : Buffer.from(encoded, "base64");
if (
  encoded !== null
  && masterKey.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
) {
  throw new Error("Runner token master key has invalid base64 encoding.");
}
if (masterKey.byteLength < 32) {
  throw new Error("Runner token master key must contain at least 32 bytes.");
}
process.stdout.write(createHmac("sha256", masterKey)
  .update(`panda-runner-auth-v1\0${kind}\0${agentKey}\0${scopeId}`)
  .digest("base64url"));
