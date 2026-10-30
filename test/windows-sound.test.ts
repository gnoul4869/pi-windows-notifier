import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsPaths } from "../src/launcher.ts";
import { wave } from "./sound-fixtures.ts";

const script = fileURLToPath(new URL("../src/windows-sound.ps1", import.meta.url));
const paths = process.platform === "win32" && ["x64", "arm64"].includes(process.arch) ? windowsPaths(process.env) : undefined;
/** Calls only the validation and reading functions; never Play-LocalWave or any sound API. */
function checkFiles(files: string[]): Array<{ ok: boolean; size: number }> {
  const command = `
    Set-StrictMode -Version Latest
    $ErrorActionPreference = "Stop"
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    . $request.script
    $results = @(foreach ($path in $request.files) {
      try { $bytes = Read-LocalWave $path; @{ ok = $true; size = $bytes.Length } }
      catch { @{ ok = $false; size = 0 } }
    })
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $results -Compress))
  `;
  const result = spawnSync(paths!.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    { input: JSON.stringify({ script, files }), encoding: "utf8", env: paths!.env, shell: false,
      windowsHide: true, timeout: 15_000, maxBuffer: 8192 });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout.trim());
}

test("Bounded WAV reading and PCM validation, handling spaces, quotes, Unicode, and command-like file names", { skip: !paths }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-notifier-wave-"));
  try {
    const extendedFormat = Buffer.concat([wave().subarray(0, 36), Buffer.alloc(2), wave().subarray(36)]);
    extendedFormat.writeUInt32LE(extendedFormat.length - 8, 4);
    extendedFormat.writeUInt32LE(18, 16);
    const metadata = Buffer.concat([wave().subarray(0, 36), Buffer.from([74, 85, 78, 75, 3, 0, 0, 0, 1, 2, 3, 0]), wave().subarray(36)]);
    metadata.writeUInt32LE(metadata.length - 8, 4);
    const valid = [wave(), wave({ channels: 2, bits: 16, sampleRate: 48000 }), wave({ seconds: 15 }),
      wave({ seconds: 0.010125 }), extendedFormat, metadata];
    const files = valid.map((bytes, index) => {
      const path = join(dir, `it's $(PRIVATE); done 😀 ${index}.wav`);
      writeFileSync(path, bytes);
      return path;
    });
    assert.deepEqual(checkFiles(files), valid.map(bytes => ({ ok: true, size: bytes.length })));
  } finally { rmSync(dir, { recursive: true }); }
});

test("Rejects missing, directory, oversized, truncated, forged, and over-long sounds, with no playback or fallback", { skip: !paths }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-notifier-bad-wave-"));
  try {
    const forged = (offset: number, value: number, length: 2 | 4 = 4) => {
      const bytes = wave();
      if (length === 2) bytes.writeUInt16LE(value, offset); else bytes.writeUInt32LE(value, offset);
      return bytes;
    };
    const duplicateFormat = Buffer.concat([wave(), wave().subarray(12, 36)]);
    duplicateFormat.writeUInt32LE(duplicateFormat.length - 8, 4);
    const duplicateData = Buffer.concat([wave(), wave().subarray(36)]);
    duplicateData.writeUInt32LE(duplicateData.length - 8, 4);
    const fixtures = [Buffer.from("not a WAV"), Buffer.alloc(10485761), wave().subarray(0, 43),
      forged(4, 0), forged(16, 0xffffffff), forged(20, 3, 2), forged(22, 3, 2), forged(24, 96000),
      forged(28, 0), forged(32, 0, 2), forged(34, 24, 2), forged(40, 0), forged(40, 0xffffffff),
      wave({ seconds: 15.01 }), duplicateFormat, duplicateData];
    const files = fixtures.map((bytes, index) => {
      const path = join(dir, `${index}.wav`);
      writeFileSync(path, bytes);
      return path;
    });
    const directory = join(dir, "directory.wav");
    mkdirSync(directory);
    files.push(join(dir, "missing.wav"), directory);
    assert.deepEqual(checkFiles(files), files.map(() => ({ ok: false, size: 0 })));
  } finally { rmSync(dir, { recursive: true }); }
});

test("Rejects ancestor junctions so a link can't redirect elsewhere", { skip: !paths }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-notifier-junction-"));
  const target = join(dir, "target");
  const link = join(dir, "link");
  try {
    mkdirSync(target);
    writeFileSync(join(target, "done.wav"), wave());
    symlinkSync(target, link, "junction");
    assert.deepEqual(checkFiles([join(link, "done.wav")]), [{ ok: false, size: 0 }]);
  } finally { rmSync(dir, { recursive: true }); }
});

/** Calls only Read-LocalWave, Get-WaveDataLayout, and Set-WaveGain; never any sound API. */
function applyGain(requests: Array<{ path: string; gain: number }>): Array<{ ok: boolean; samples: number[] }> {
  const command = `
    Set-StrictMode -Version Latest
    $ErrorActionPreference = "Stop"
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    . $request.script
    $results = @(foreach ($item in $request.files) {
      try {
        $bytes = Read-LocalWave $item.path
        Set-WaveGain $bytes $item.gain
        $layout = Get-WaveDataLayout $bytes
        $start = [int] $layout[0]
        $size = [int] $layout[1]
        $samples = @()
        if ([int] $layout[2] -eq 16) {
          for ($i = 0; $i -lt $size / 2; $i++) { $samples += [BitConverter]::ToInt16($bytes, $start + $i * 2) }
        } else {
          for ($i = 0; $i -lt $size; $i++) { $samples += $bytes[$start + $i] - 128 }
        }
        @{ ok = $true; samples = $samples }
      } catch { @{ ok = $false; samples = @() } }
    })
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $results -Depth 6 -Compress))
  `;
  const result = spawnSync(paths!.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    { input: JSON.stringify({ script, files: requests }), encoding: "utf8", env: paths!.env, shell: false,
      windowsHide: true, timeout: 15_000, maxBuffer: 8192 });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout.trim());
}

/** Fills one PCM WAV with known samples and zeros for the rest. */
function samples16(samples: number[]): Buffer {
  const bytes = wave({ seconds: 0.002, bits: 16, sampleRate: 8000 });
  for (let index = 0; index < samples.length; index += 1) bytes.writeInt16LE(samples[index], 44 + index * 2);
  return bytes;
}
function samples8(samples: number[]): Buffer {
  const bytes = wave({ seconds: 0.002, sampleRate: 8000 });
  for (let index = 0; index < samples.length; index += 1) bytes[44 + index] = samples[index] + 128;
  return bytes;
}

test("Set-WaveGain scales 8/16-bit PCM in place and clips samples beyond range", { skip: !paths }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-notifier-gain-"));
  try {
    const loud = samples16([0, 1000, -1000, 32767, -32768, 20000, 30000, -30000, 0, 0, 0, 0, 0, 0, 0, 0]);
    const quiet = samples8([0, 100, -100, 127, -128, 72, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const loudPath = join(dir, "it's $(PRIVATE); done 😀 16.wav");
    const quietPath = join(dir, "gain 8.wav");
    writeFileSync(loudPath, loud);
    writeFileSync(quietPath, quiet);
    const zeros = new Array(10).fill(0);
    assert.deepEqual(applyGain([
      { path: loudPath, gain: 1 },
      { path: loudPath, gain: 0.5 },
      { path: loudPath, gain: 0.9 },
      { path: quietPath, gain: 1 },
      { path: quietPath, gain: 0.5 },
      { path: quietPath, gain: 1.5 },
    ]), [
      { ok: true, samples: [0, 1000, -1000, 32767, -32768, 20000, 30000, -30000, ...new Array(8).fill(0)] },
      { ok: true, samples: [0, 500, -500, 16384, -16384, 10000, 15000, -15000, ...new Array(8).fill(0)] },
      { ok: true, samples: [0, 900, -900, 29490, -29491, 18000, 27000, -27000, ...new Array(8).fill(0)] },
      { ok: true, samples: [0, 100, -100, 127, -128, 72, ...zeros] },
      { ok: true, samples: [0, 50, -50, 64, -64, 36, ...zeros] },
      { ok: true, samples: [0, 127, -128, 127, -128, 108, ...zeros] },
    ]);
    // Gain only changes bytes in memory; the file on disk is untouched.
    assert.deepEqual(readFileSync(loudPath), loud);
    assert.deepEqual(readFileSync(quietPath), quiet);
  } finally { rmSync(dir, { recursive: true }); }
});
