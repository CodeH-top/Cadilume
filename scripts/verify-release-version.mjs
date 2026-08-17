import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

export const RELEASE_FILES = Object.freeze([
  "package.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
]);

export function normalizeReleaseVersion(input) {
  const value = typeof input === "string" ? input.trim() : undefined;
  const match = value?.match(/^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) {
    throw new Error("发布版本必须是稳定 SemVer，例如 0.2.0、v0.2.0 或 V0.2.0");
  }

  const version = `${match[1]}.${match[2]}.${match[3]}`;
  return { version, tag: `v${version}` };
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
  return content.slice(start, end);
}

function findCargoLockPackage(content, packageName, source) {
  const headings = [...content.matchAll(/^\[\[package\]\]\s*$/gm)];
  const matches = headings
    .map((heading, index) => {
      const start = heading.index;
      const end = headings[index + 1]?.index ?? content.length;
      return content.slice(start, end);
    })
    .filter((section) => /^name\s*=\s*"([^"]+)"\s*$/m.exec(section)?.[1] === packageName);

  if (matches.length !== 1) {
    throw new Error(`${source} 中应恰好有一个 ${packageName} 包，实际为 ${matches.length} 个`);
  }
  return matches[0];
}

function readTomlVersion(section, source) {
  const version = /^version\s*=\s*"([^"]+)"\s*$/m.exec(section)?.[1];
  if (!version) throw new Error(`${source} 缺少 version`);
  return version;
}

export function readReleaseVersions(projectRoot = DEFAULT_PROJECT_ROOT) {
  const read = (relativePath) => readFileSync(path.join(projectRoot, relativePath), "utf8");
  const packageJson = JSON.parse(read(RELEASE_FILES[0]));
  const tauriConfig = JSON.parse(read(RELEASE_FILES[1]));
  const cargoManifest = read(RELEASE_FILES[2]);
  const cargoLock = read(RELEASE_FILES[3]);

  return new Map([
    [RELEASE_FILES[0], packageJson.version],
    [RELEASE_FILES[1], tauriConfig.version],
    [
      RELEASE_FILES[2],
      readTomlVersion(findCargoSection(cargoManifest, "package", RELEASE_FILES[2]), RELEASE_FILES[2]),
    ],
    [
      RELEASE_FILES[3],
      readTomlVersion(findCargoLockPackage(cargoLock, "cadilume", RELEASE_FILES[3]), RELEASE_FILES[3]),
    ],
  ]);
}

export function verifyReleaseVersion(
  input,
  projectRoot = DEFAULT_PROJECT_ROOT,
  environment = process.env,
) {
  const versions = readReleaseVersions(projectRoot);
  const repositoryVersion = versions.get(RELEASE_FILES[0]);
  const repositoryRelease = normalizeReleaseVersion(repositoryVersion);

  if (repositoryRelease.version !== repositoryVersion) {
    throw new Error(`${RELEASE_FILES[0]} 的版本必须是不带 v 前缀的稳定 SemVer`);
  }
  for (const [source, version] of versions) {
    if (version !== repositoryVersion) {
      throw new Error(`发布版本不一致：${source}=${version}，期望 ${repositoryVersion}`);
    }
  }

  const requestedRelease = typeof input === "string" && input.trim()
    ? normalizeReleaseVersion(input)
    : repositoryRelease;
  if (requestedRelease.version !== repositoryVersion) {
    throw new Error(
      `构建版本 ${requestedRelease.version} 与仓库版本 ${repositoryVersion} 不一致；` +
      `请先更新并提交 ${RELEASE_FILES.join("、")}`,
    );
  }

  if (environment.CADILUME_PUBLISH === "true" && environment.GITHUB_REF !== "refs/heads/main") {
    throw new Error("公开发布只能从 main 分支手动执行");
  }

  return requestedRelease;
}

function runCli() {
  const result = verifyReleaseVersion(process.env.CADILUME_RELEASE_VERSION ?? process.argv[2]);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\ntag=${result.tag}\n`);
  }
  console.log(`Cadilume 发布版本校验通过：${result.tag}（未修改版本文件）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
