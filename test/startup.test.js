import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
function powershell(code) {
  const executable = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return spawnSync(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from("$ErrorActionPreference='Stop';" + code, "utf16le").toString("base64")],
  { encoding: "utf8", timeout: 30000 });
}
const windows = { skip: process.platform !== "win32" };

test("startup PowerShell files parse and an explicit Node.js can prepare without downloads", windows, () => {
  const scripts = ["start.ps1", "scripts\\ensure-node.ps1", "scripts\\package.ps1"];
  for (const script of scripts) {
    const result = powershell(`$tokens=$null;$errors=$null;
      [void][System.Management.Automation.Language.Parser]::ParseFile(${quote(join(root, script))},
      [ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors | Out-String)}`);
    assert.equal(result.status, 0, result.stderr);
  }
  const result = powershell(`& ${quote(join(root, "start.ps1"))} -PrepareOnly -NodePath ${quote(process.execPath)}`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(process.execPath));
});

test("an invalid explicit Node.js fails instead of downloading or falling back", windows, () => {
  const result = powershell(`& ${quote(join(root, "start.ps1"))} -PrepareOnly -NodePath 'Z:\\missing-node.exe'`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /specified Node.js/);
});

test("cached user-local Node.js is reused offline without modifying its files", windows, () => {
  const folder = mkdtempSync(join(tmpdir(), "studio-node-cache-"));
  try {
    const directory = join(folder, "RobotSceneStudio", "runtime", "node-v99-test");
    mkdirSync(directory, { recursive: true });
    const executable = join(directory, "node.exe");
    copyFileSync(process.execPath, executable);
    const result = powershell(`$env:LOCALAPPDATA=${quote(folder)};
      $env:PATH='';$env:ProgramFiles=${quote(folder)};\${env:ProgramFiles(x86)}=${quote(folder)};
      $env:USERPROFILE=${quote(folder)};$env:NVM_HOME='';$env:NVM_SYMLINK='';$env:VOLTA_HOME='';
      function Invoke-RestMethod { throw 'Unexpected network request' }
      & ${quote(join(root, "start.ps1"))} -PrepareOnly`);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(executable));
    assert.deepEqual(readdirSync(directory), ["node.exe"]);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("runtime checksum mismatch aborts execution and removes only its staging directory", windows, () => {
  const folder = mkdtempSync(join(tmpdir(), "studio-node-hash-"));
  try {
    const result = powershell(`$env:LOCALAPPDATA=${quote(folder)};
      $env:PROCESSOR_ARCHITEW6432='AMD64';
      function Invoke-RestMethod {
        return [pscustomobject]@{lts='Test';version='v99.0.0';files=@('win-x64-zip')}
      }
      function Invoke-WebRequest {
        param($Uri,$OutFile,$TimeoutSec,[switch]$UseBasicParsing)
        if($OutFile){[IO.File]::WriteAllText($OutFile,'corrupted runtime');return}
        return [pscustomobject]@{Content=(('0'*64)+'  node-v99.0.0-win-x64.zip')}
      }
      & ${quote(join(root, "scripts", "ensure-node.ps1"))} -InstallLocalNode`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum mismatch/);
    assert.deepEqual(readdirSync(join(folder, "RobotSceneStudio", "runtime")), []);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
