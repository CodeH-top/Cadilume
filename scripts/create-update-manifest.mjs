import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function collectFiles(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const candidate = path.join(root, entry);
    if (statSync(candidate).isDirectory()) files.push(...collectFiles(candidate));
    else files.push(candidate);
  }
  return files;
}

function findSingle(files, suffix, label) {
  const matches = files.filter((file) => file.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(`${label} 应恰好有 1 个，实际为 ${matches.length} 个`);
  }
  return matches[0];
}

function releaseAssetUrl(repository, tag, file) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(path.basename(file))}`;
}

export function createUpdateManifest({ artifactRoot, repository, tag, version, publishedAt }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`更新清单版本不是稳定 SemVer：${version}`);
  }
  if (tag !== `v${version}`) throw new Error(`更新清单标签 ${tag} 与版本 v${version} 不一致`);
  if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error(`GitHub 仓库格式无效：${repository}`);

  const files = collectFiles(artifactRoot);
  const macArchive = findSingle(files, ".app.tar.gz", "macOS updater 归档");
  const macSignature = findSingle(files, ".app.tar.gz.sig", "macOS updater 签名");
  const windowsInstaller = findSingle(files, "-setup.exe", "Windows NSIS updater 安装器");
  const windowsSignature = findSingle(files, "-setup.exe.sig", "Windows updater 签名");
  if (windowsSignature !== `${windowsInstaller}.sig`) {
    throw new Error("Windows updater 签名与 NSIS 安装器不匹配");
  }
  const macUpdate = {
    signature: readFileSync(macSignature, "utf8").trim(),
    url: releaseAssetUrl(repository, tag, macArchive),
  };
  const windowsUpdate = {
    signature: readFileSync(windowsSignature, "utf8").trim(),
    url: releaseAssetUrl(repository, tag, windowsInstaller),
  };
  if (!macUpdate.signature || !windowsUpdate.signature) throw new Error("updater 签名不能为空");

  return {
    version,
    notes: `Cadilume ${tag}`,
    pub_date: publishedAt ?? new Date().toISOString(),
    platforms: {
      "darwin-aarch64": macUpdate,
      "darwin-aarch64-app": macUpdate,
      "windows-x86_64": windowsUpdate,
      "windows-x86_64-nsis": windowsUpdate,
    },
  };
}

function runCli() {
  const manifest = createUpdateManifest({
    artifactRoot: path.resolve(process.env.CADILUME_ARTIFACT_ROOT ?? "desktop-artifacts"),
    repository: process.env.GITHUB_REPOSITORY ?? "",
    tag: process.env.CADILUME_RELEASE_TAG ?? "",
    version: process.env.CADILUME_RELEASE_VERSION ?? "",
  });
  const outputPath = path.resolve(process.env.CADILUME_UPDATE_MANIFEST_PATH ?? "latest.json");
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `manifest=${outputPath}\n`);
  console.log(`已生成双平台 updater 清单：${outputPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
