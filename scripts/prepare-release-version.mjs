import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

const RELEASE_FILES = Object.freeze({
  packageJson: "package.json",
  tauriConfig: "src-tauri/tauri.conf.json",
  cargoManifest: "src-tauri/Cargo.toml",
  cargoLock: "src-tauri/Cargo.lock",
});

export function normalizeReleaseVersion(input) {
  const value = input?.trim();
  const match = value?.match(/^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) {
    throw new Error("发布版本必须是稳定 SemVer，例如 0.2.0、v0.2.0 或 V0.2.0");
  }

  const version = `${match[1]}.${match[2]}.${match[3]}`;
  return { version, tag: `v${version}` };
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(BigInt);
  const rightParts = right.split(".").map(BigInt);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

function findCargoSection(content, heading, source) {
  const headingMatch = new RegExp(`^\\[${heading}\\]\\s*$`, "m").exec(content);
  if (!headingMatch) throw new Error(`${source} 缺少 [${heading}]`);

  const start = headingMatch.index;
  const remainder = content.slice(start + headingMatch[0].length);
  const nextHeading = /^\s*\[[^\r\n]+\]\s*$/m.exec(remainder);
  const end = nextHeading
    ? start + headingMatch[0].length + nextHeading.index
    : content.length;
  return { start, end, text: content.slice(start, end) };
}

function findCargoLockPackage(content, packageName, source) {
  const headings = [...content.matchAll(/^\[\[package\]\]\s*$/gm)];
  const matches = headings
    .map((heading, index) => {
      const start = heading.index;
      const end = headings[index + 1]?.index ?? content.length;
      return { start, end, text: content.slice(start, end) };
    })
    .filter(({ text }) => {
      const name = /^name\s*=\s*"([^"]+)"\s*$/m.exec(text)?.[1];
      return name === packageName;
    });

  if (matches.length !== 1) {
    throw new Error(`${source} 中应恰好有一个 ${packageName} 包，实际为 ${matches.length} 个`);
  }
  return matches[0];
}

function readTomlVersion(section, source) {
  const version = /^version\s*=\s*"([^"]+)"/m.exec(section)?.[1];
  if (!version) throw new Error(`${source} 缺少 version`);
  return version;
}

function replaceTomlVersion(content, region, version, source) {
  const replaced = region.text.replace(
    /^(version\s*=\s*")[^"]+(".*)$/m,
    (_match, prefix, suffix) => `${prefix}${version}${suffix}`,
  );
  if (replaced === region.text && readTomlVersion(region.text, source) !== version) {
    throw new Error(`${source} 无法更新 version`);
  }
  return `${content.slice(0, region.start)}${replaced}${content.slice(region.end)}`;
}

function readReleaseFiles(projectRoot) {
  const paths = Object.fromEntries(
    Object.entries(RELEASE_FILES).map(([key, relativePath]) => [key, path.join(projectRoot, relativePath)]),
  );
  const contents = Object.fromEntries(
    Object.entries(paths).map(([key, filePath]) => [key, readFileSync(filePath, "utf8")]),
  );

  const packageJson = JSON.parse(contents.packageJson);
  const tauriConfig = JSON.parse(contents.tauriConfig);
  const cargoPackage = findCargoSection(contents.cargoManifest, "package", RELEASE_FILES.cargoManifest);
  const cargoLockPackage = findCargoLockPackage(
    contents.cargoLock,
    "cadilume",
    RELEASE_FILES.cargoLock,
  );

  return {
    paths,
    contents,
    packageJson,
    tauriConfig,
    cargoPackage,
    cargoLockPackage,
    versions: new Map([
      [RELEASE_FILES.packageJson, packageJson.version],
      [RELEASE_FILES.tauriConfig, tauriConfig.version],
      [RELEASE_FILES.cargoManifest, readTomlVersion(cargoPackage.text, RELEASE_FILES.cargoManifest)],
      [RELEASE_FILES.cargoLock, readTomlVersion(cargoLockPackage.text, RELEASE_FILES.cargoLock)],
    ]),
  };
}

export function prepareReleaseVersion(input, projectRoot = DEFAULT_PROJECT_ROOT) {
  const target = normalizeReleaseVersion(input);
  const releaseFiles = readReleaseFiles(projectRoot);
  const currentVersion = releaseFiles.packageJson.version;
  normalizeReleaseVersion(currentVersion);

  for (const [source, version] of releaseFiles.versions) {
    if (version !== currentVersion) {
      throw new Error(`当前版本不一致：${source}=${version}，期望 ${currentVersion}`);
    }
  }
  if (compareVersions(target.version, currentVersion) < 0) {
    throw new Error(`发布版本 ${target.version} 不能低于当前版本 ${currentVersion}`);
  }

  const changedFiles = [];
  if (target.version !== currentVersion) {
    releaseFiles.packageJson.version = target.version;
    releaseFiles.tauriConfig.version = target.version;
    const updatedContents = {
      packageJson: `${JSON.stringify(releaseFiles.packageJson, null, 2)}\n`,
      tauriConfig: `${JSON.stringify(releaseFiles.tauriConfig, null, 2)}\n`,
      cargoManifest: replaceTomlVersion(
        releaseFiles.contents.cargoManifest,
        releaseFiles.cargoPackage,
        target.version,
        RELEASE_FILES.cargoManifest,
      ),
      cargoLock: replaceTomlVersion(
        releaseFiles.contents.cargoLock,
        releaseFiles.cargoLockPackage,
        target.version,
        RELEASE_FILES.cargoLock,
      ),
    };
    for (const key of Object.keys(updatedContents)) {
      writeFileSync(releaseFiles.paths[key], updatedContents[key]);
      changedFiles.push(RELEASE_FILES[key]);
    }
  }

  return {
    ...target,
    previousVersion: currentVersion,
    changed: changedFiles.length > 0,
    changedFiles,
  };
}

function runCli() {
  const result = prepareReleaseVersion(
    process.env.CADILUME_RELEASE_VERSION ?? process.argv[2],
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${result.version}\ntag=${result.tag}\nchanged=${result.changed}\n`,
    );
  }
  const transition = result.changed
    ? `${result.previousVersion} -> ${result.version}`
    : `${result.version}（无需改动）`;
  console.log(`Cadilume 发布版本已准备：${transition}，标签 ${result.tag}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
