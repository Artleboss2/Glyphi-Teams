#!/usr/bin/env node
/**
 * Sign what can be signed on the machine running the build.
 *
 * - Windows: the packaged app and the Squirrel setup are signed with an
 *   Authenticode certificate from the current user's store. When no code-signing
 *   certificate exists yet, a self-signed one is created once under the name
 *   "Glyphi Teams" so a build always leaves the machine signed.
 * - Linux: every AppImage, deb and rpm gets a detached GPG signature (.asc).
 * - macOS: deliberately left unsigned. Apple requires a paid Developer ID and a
 *   notarisation round-trip; the DMG ships as it is.
 *
 * Nothing here needs administrator rights and nothing leaves the machine except
 * the timestamp request Windows makes while signing.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MAKE = path.join(ROOT, "apps", "desktop", "out", "make");
const PACKAGED = path.join(ROOT, "apps", "desktop", "out");

function sh(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function run(command, args, options = {}) {
  try {
    const output = sh(command, args, options);
    return { ok: true, output: String(output ?? "") };
  } catch (error) {
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}` || error.message;
    return { ok: false, output: String(output) };
  }
}

function collect(directory, extensions) {
  if (!fs.existsSync(directory)) return [];
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...collect(location, extensions));
    else if (extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))) found.push(location);
  }
  return found;
}

function powershell(script) {
  return run("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
}

function signWindows() {
  const executables = [
    ...collect(path.join(PACKAGED), [".exe"]).filter((file) => /Glyphi( Teams)?\.exe$/u.test(file)),
    ...collect(path.join(MAKE, "squirrel.windows"), [".exe"])
  ];
  if (executables.length === 0) {
    console.log("windows: no executable to sign");
    return;
  }

  const ensure = powershell([
    "$existing = Get-ChildItem Cert:\\CurrentUser\\My |",
    "  Where-Object { $_.HasPrivateKey -and $_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3' } |",
    "  Sort-Object NotAfter -Descending | Select-Object -First 1;",
    "if (-not $existing) {",
    "  $existing = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Glyphi Teams' -FriendlyName 'Glyphi Teams build key' -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddYears(5);",
    "  Write-Output 'created'",
    "}",
    "Write-Output $existing.Thumbprint"
  ].join("\n"));

  const thumbprint = (ensure.output || "").trim().split(/\r?\n/).pop();
  if (!ensure.ok || !/^[0-9A-F]{40}$/iu.test(thumbprint ?? "")) {
    console.log(`windows: no certificate available (${ensure.output.trim().slice(0, 200)})`);
    return;
  }

  for (const file of executables) {
    const result = powershell(
      `$cert = Get-ChildItem Cert:\\CurrentUser\\My\\${thumbprint};` +
        ` $signature = Set-AuthenticodeSignature -FilePath '${file.replace(/'/gu, "''")}' -Certificate $cert` +
        " -TimestampServer 'http://timestamp.digicert.com';" +
        " Write-Output $signature.Status"
    );
    console.log(`windows: ${path.basename(file)} -> ${result.output.trim().split(/\r?\n/).pop() || "unknown"}`);
  }
}

function signLinux() {
  const artifacts = collect(MAKE, [".appimage", ".deb", ".rpm"]);
  if (artifacts.length === 0) {
    console.log("linux: no package to sign");
    return;
  }
  const hasGpg = run("gpg", ["--version"]).ok;
  if (!hasGpg) {
    console.log("linux: gpg is not installed, artifacts left unsigned");
    return;
  }
  for (const file of artifacts) {
    const result = run("gpg", [
      "--batch",
      "--yes",
      "--armor",
      "--detach-sign",
      "--local-user",
      process.env.GLYPHI_GPG_KEY ?? "Glyphi Teams",
      file
    ]);
    console.log(`linux: ${path.basename(file)} -> ${result.ok ? "signed" : "failed"}`);
  }
}

if (process.platform === "win32") signWindows();
else if (process.platform === "linux") signLinux();
else console.log("macos: builds are shipped unsigned on purpose");
