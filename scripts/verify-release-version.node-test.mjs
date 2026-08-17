import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeReleaseVersion,
  RELEASE_FILES,
  verifyReleaseVersion,
} from "./verify-release-version.mjs";

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

function snapshotReleaseFiles(root) {
  return new Map(RELEASE_FILES.map((relativePath) => [
    relativePath,
    readFileSync(path.join(root, relativePath), "utf8"),
  ]));
}

function assertReleaseFilesUnchanged(root, before) {
  for (const [relativePath, content] of before) {
    assert.equal(readFileSync(path.join(root, relativePath), "utf8"), content, relativePath);
  }
}

function withReadOnlyFixture(callback) {
  const root = createFixture();
  const before = snapshotReleaseFiles(root);
  try {
    return callback(root);
  } finally {
    try {
      assertReleaseFilesUnchanged(root, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

test("normalizes plain and prefixed stable versions", () => {
  assert.deepEqual(normalizeReleaseVersion("0.2.0"), { version: "0.2.0", tag: "v0.2.0" });
  assert.deepEqual(normalizeReleaseVersion("v1.20.3"), { version: "1.20.3", tag: "v1.20.3" });
  assert.deepEqual(normalizeReleaseVersion(" V2.0.1 "), { version: "2.0.1", tag: "v2.0.1" });
});

test("rejects invalid, prerelease, and leading-zero versions", () => {
  for (const version of [undefined, null, 123, "", "1.2", "01.2.3", "v1.2.3-beta.1"]) {
    assert.throws(() => normalizeReleaseVersion(version), /稳定 SemVer/);
  }
});

test("accepts the committed version without changing any release file", () => withReadOnlyFixture((root) => {
  assert.deepEqual(verifyReleaseVersion("V0.1.2", root, {}), {
    version: "0.1.2",
    tag: "v0.1.2",
  });
  assert.deepEqual(verifyReleaseVersion(undefined, root, {}), {
    version: "0.1.2",
    tag: "v0.1.2",
  });
}));

test("rejects a requested version that was not committed", () => withReadOnlyFixture((root) => {
  assert.throws(
    () => verifyReleaseVersion("0.2.0", root, {}),
    /构建版本 0\.2\.0 与仓库版本 0\.1\.2 不一致.*请先更新并提交/,
  );
}));

test("rejects pre-existing version drift in every secondary source", () => {
  const driftCases = [
    ["src-tauri/tauri.conf.json", (content) => content.replace('"version": "0.1.2"', '"version": "0.1.1"')],
    ["src-tauri/Cargo.toml", (content) => content.replace('version = "0.1.2"', 'version = "0.1.1"')],
    ["src-tauri/Cargo.lock", (content) => content.replace('name = "cadilume"\nversion = "0.1.2"', 'name = "cadilume"\nversion = "0.1.1"')],
  ];

  for (const [relativePath, createDrift] of driftCases) {
    const root = createFixture();
    const filePath = path.join(root, relativePath);
    writeFileSync(filePath, createDrift(readFileSync(filePath, "utf8")));
    const before = snapshotReleaseFiles(root);
    try {
      assert.throws(() => verifyReleaseVersion("0.1.2", root, {}), /发布版本不一致/);
      assertReleaseFilesUnchanged(root, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("allows publishing only from main", () => withReadOnlyFixture((root) => {
  assert.deepEqual(
    verifyReleaseVersion("0.1.2", root, {
      CADILUME_PUBLISH: "true",
      GITHUB_REF: "refs/heads/main",
    }),
    { version: "0.1.2", tag: "v0.1.2" },
  );
  assert.throws(
    () => verifyReleaseVersion("0.1.2", root, {
      CADILUME_PUBLISH: "true",
      GITHUB_REF: "refs/heads/dev",
    }),
    /只能从 main 分支/,
  );
}));

test("desktop workflow is unified and never mutates version control", () => {
  const workflowUrl = new URL("../.github/workflows/build-desktop.yml", import.meta.url);
  const workflow = readFileSync(workflowUrl, "utf8");
  assert.equal((workflow.match(/pnpm verify:release-version/g) ?? []).length, 4);
  assert.match(workflow, /Build macOS arm64/);
  assert.match(workflow, /Build Windows x64/);
  assert.match(workflow, /Publish immutable desktop release/);
  assert.match(workflow, /pnpm create:update-manifest/);
  assert.doesNotMatch(workflow, /prepare:release-version|prepare-release-version/);
  assert.doesNotMatch(workflow, /\bgit\s+(?:add|commit|push)\b/);
  assert.doesNotMatch(workflow, /--no-sign/);
  assert.doesNotMatch(workflow, /release_commit|github-actions\[bot\]/);
  assert.match(workflow, /release_sha="\$\(git rev-parse HEAD\)"/);
  assert.equal(
    existsSync(new URL("../.github/workflows/release-macos.yml", import.meta.url)),
    false,
  );
  assert.equal(
    existsSync(new URL("../.github/workflows/windows.yml", import.meta.url)),
    false,
  );
});

test("desktop release configuration produces a signed bilingual Windows updater", () => {
  const releaseConfig = JSON.parse(readFileSync(
    new URL("../src-tauri/tauri.release.conf.json", import.meta.url),
    "utf8",
  ));
  const windowsConfig = JSON.parse(readFileSync(
    new URL("../src-tauri/tauri.windows.conf.json", import.meta.url),
    "utf8",
  ));
  const nsis = windowsConfig.bundle?.windows?.nsis;

  assert.equal(releaseConfig.bundle?.createUpdaterArtifacts, true);
  assert.deepEqual(windowsConfig.bundle?.targets, ["nsis"]);
  assert.equal(nsis?.installMode, "currentUser");
  assert.deepEqual(nsis?.languages, ["English", "SimpChinese"]);
  assert.equal(nsis?.displayLanguageSelector, true);
});
