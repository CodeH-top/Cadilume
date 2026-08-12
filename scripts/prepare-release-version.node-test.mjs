import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeReleaseVersion,
  prepareReleaseVersion,
} from "./prepare-release-version.mjs";

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "cadilume-release-version-"));
  mkdirSync(path.join(root, "src-tauri"));
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "top.codeh.cadilume", version: "0.1.2" }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(root, "src-tauri/tauri.conf.json"),
    `${JSON.stringify({ productName: "Cadilume", version: "0.1.2" }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(root, "src-tauri/Cargo.toml"),
    `[package]\nname = "cadilume"\nversion = "0.1.2"\n\n[dependencies]\nexample = "0.1.2"\n`,
  );
  writeFileSync(
    path.join(root, "src-tauri/Cargo.lock"),
    `version = 4\n\n[[package]]\nname = "cadilume"\nversion = "0.1.2"\ndependencies = [\n "example",\n]\n\n[[package]]\nname = "example"\nversion = "0.1.2"\nsource = "registry+https://example.invalid"\n`,
  );
  return root;
}

function withFixture(callback) {
  const root = createFixture();
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("normalizes plain and prefixed stable versions", () => {
  assert.deepEqual(normalizeReleaseVersion("0.2.0"), { version: "0.2.0", tag: "v0.2.0" });
  assert.deepEqual(normalizeReleaseVersion("v1.20.3"), { version: "1.20.3", tag: "v1.20.3" });
  assert.deepEqual(normalizeReleaseVersion(" V2.0.1 "), { version: "2.0.1", tag: "v2.0.1" });
});

test("rejects invalid, prerelease, and leading-zero versions", () => {
  for (const version of [undefined, "", "1.2", "01.2.3", "v1.2.3-beta.1"]) {
    assert.throws(() => normalizeReleaseVersion(version), /稳定 SemVer/);
  }
});

test("updates only Cadilume release versions", () => withFixture((root) => {
  const result = prepareReleaseVersion("V0.2.0", root);
  assert.equal(result.version, "0.2.0");
  assert.equal(result.tag, "v0.2.0");
  assert.equal(result.changed, true);

  assert.equal(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version, "0.2.0");
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")).version,
    "0.2.0",
  );
  const manifest = readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");
  assert.match(manifest, /name = "cadilume"\nversion = "0\.2\.0"/);
  assert.match(manifest, /example = "0\.1\.2"/);
  const lock = readFileSync(path.join(root, "src-tauri/Cargo.lock"), "utf8");
  assert.match(lock, /name = "cadilume"\nversion = "0\.2\.0"/);
  assert.match(lock, /name = "example"\nversion = "0\.1\.2"/);
}));

test("allows a retry of the current version without rewriting files", () => withFixture((root) => {
  const before = readFileSync(path.join(root, "package.json"), "utf8");
  const result = prepareReleaseVersion("v0.1.2", root);
  assert.equal(result.changed, false);
  assert.equal(readFileSync(path.join(root, "package.json"), "utf8"), before);
}));

test("rejects downgrades and pre-existing version drift", () => withFixture((root) => {
  assert.throws(() => prepareReleaseVersion("0.1.1", root), /不能低于当前版本/);

  const tauriPath = path.join(root, "src-tauri/tauri.conf.json");
  const tauriConfig = JSON.parse(readFileSync(tauriPath, "utf8"));
  tauriConfig.version = "0.1.1";
  writeFileSync(tauriPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);
  assert.throws(() => prepareReleaseVersion("0.2.0", root), /当前版本不一致/);
}));
