#!/usr/bin/env node
/**
 * Prove the Freebuff cloud quota path works, outside Electron.
 *
 *   npx bun@1.3.14 run check:freebuff-usage
 *
 * It resolves the token the same way the app does — FREEBUFF_API_KEY, then
 * %APPDATA%\Glyphi\freebuff-api-key, then ~/.config/glyphi/freebuff-api-key,
 * then a CLI credentials.json — and makes one GET to the session endpoint.
 * Nothing is cached and nothing is written: if the token is missing it says so
 * and exits 1.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();
const appData = process.env.APPDATA?.trim();

function token() {
  const fromEnvironment = process.env.FREEBUFF_API_KEY?.trim() || process.env.CODEBUFF_API_KEY?.trim();
  if (fromEnvironment) return { token: fromEnvironment, from: "environment" };

  const files = [
    ...(appData ? [path.join(appData, "Glyphi", "freebuff-api-key")] : []),
    path.join(home, ".config", "glyphi", "freebuff-api-key"),
    path.join(home, ".config", "manicode", "credentials.json"),
    path.join(home, ".config", "freebuff", "credentials.json")
  ];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8").trim();
    if (file.endsWith(".json")) {
      const parsed = JSON.parse(raw);
      const value = parsed?.default?.authToken ?? parsed?.authToken;
      if (typeof value === "string" && value.length >= 20) return { token: value, from: file };
    } else if (raw.length >= 20) {
      return { token: raw.split(/\r?\n/u)[0], from: file };
    }
  }
  return null;
}

const found = token();
if (!found) {
  console.log("No Freebuff token found.");
  console.log("Put the account token in %APPDATA%\\Glyphi\\freebuff-api-key, or export FREEBUFF_API_KEY.");
  process.exit(1);
}

const response = await fetch("https://www.codebuff.com/api/v1/freebuff/session", {
  headers: { authorization: `Bearer ${found.token}`, "include-unused-rate-limits": "1" },
  signal: AbortSignal.timeout(15_000)
});
console.log(`token from ${found.from} -> HTTP ${response.status}`);
if (!response.ok) {
  console.log((await response.text()).slice(0, 300));
  process.exit(1);
}
const body = await response.json();
console.log(JSON.stringify(body, null, 2).slice(0, 1200));
