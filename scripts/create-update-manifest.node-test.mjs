import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createUpdateManifest } from "./create-update-manifest.mjs";

function withArtifacts(callback) {
  const root = mkdtempSync(path.join(tmpdir(), "cadilume-update-manifest-"));
  const mac = path.join(root, "macos");
  const windows = path.join(root, "windows");
  mkdirSync(mac);
  mkdirSync(windows);
  writeFileSync(path.join(mac, "Cadilume.app.tar.gz"), "archive");
  writeFileSync(path.join(mac, "Cadilume.app.tar.gz.sig"), "mac-signature\n");
  writeFileSync(path.join(windows, "Cadilume_0.2.2_x64-setup.exe"), "installer");
  writeFileSync(path.join(windows, "Cadilume_0.2.2_x64-setup.exe.sig"), "windows-signature\n");
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("creates one updater manifest for macOS arm64 and Windows x64", () => withArtifacts((root) => {
  const manifest = createUpdateManifest({
    artifactRoot: root,
    repository: "CodeH-top/Cadilume",
    tag: "v0.2.2",
    version: "0.2.2",
    publishedAt: "2026-08-17T00:00:00.000Z",
  });

  assert.equal(manifest.version, "0.2.2");
  assert.equal(manifest.pub_date, "2026-08-17T00:00:00.000Z");
  assert.equal(manifest.platforms["darwin-aarch64"].signature, "mac-signature");
  assert.equal(manifest.platforms["windows-x86_64"].signature, "windows-signature");
  assert.equal(manifest.platforms["darwin-aarch64-app"], manifest.platforms["darwin-aarch64"]);
  assert.equal(manifest.platforms["windows-x86_64-nsis"], manifest.platforms["windows-x86_64"]);
  assert.match(manifest.platforms["darwin-aarch64"].url, /Cadilume\.app\.tar\.gz$/);
  assert.match(manifest.platforms["windows-x86_64"].url, /setup\.exe$/);
}));

test("rejects mismatched versions and incomplete updater artifacts", () => withArtifacts((root) => {
  assert.throws(() => createUpdateManifest({
    artifactRoot: root,
    repository: "CodeH-top/Cadilume",
    tag: "v0.2.3",
    version: "0.2.2",
  }), /标签/);

  writeFileSync(path.join(root, "duplicate.app.tar.gz"), "archive");
  assert.throws(() => createUpdateManifest({
    artifactRoot: root,
    repository: "CodeH-top/Cadilume",
    tag: "v0.2.2",
    version: "0.2.2",
  }), /macOS updater 归档/);
}));

test("rejects a Windows signature that does not match its NSIS installer", () => withArtifacts((root) => {
  const windows = path.join(root, "windows");
  rmSync(path.join(windows, "Cadilume_0.2.2_x64-setup.exe.sig"));
  writeFileSync(path.join(windows, "Different_0.2.2_x64-setup.exe.sig"), "windows-signature\n");
  assert.throws(() => createUpdateManifest({
    artifactRoot: root,
    repository: "CodeH-top/Cadilume",
    tag: "v0.2.2",
    version: "0.2.2",
  }), /签名与 NSIS 安装器不匹配/);
}));
