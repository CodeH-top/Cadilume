import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tauriConfig = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const cargoMetadata = JSON.parse(execFileSync("cargo", [
  "metadata",
  "--format-version",
  "1",
  "--no-deps",
  "--manifest-path",
  "src-tauri/Cargo.toml",
], { encoding: "utf8" }));
const cargoPackage = cargoMetadata.packages.find((candidate) => candidate.name === "cadilume");

if (!cargoPackage) throw new Error("Cargo metadata 中没有找到 cadilume 包");

const versions = new Map([
  ["package.json", packageJson.version],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
  ["src-tauri/Cargo.toml", cargoPackage.version],
]);
const expectedVersion = packageJson.version;
for (const [source, version] of versions) {
  if (version !== expectedVersion) {
    throw new Error(`发布版本不一致：${source}=${version}，期望 ${expectedVersion}`);
  }
}

const publish = process.env.CADILUME_PUBLISH === "true";
const requestedTag = process.env.CADILUME_RELEASE_TAG?.trim();
if (publish && process.env.GITHUB_REF !== "refs/heads/main") {
  throw new Error("公开发布只能从 main 分支手动执行");
}
if (publish && !requestedTag) {
  throw new Error("公开发布必须填写 release_tag");
}
const tag = requestedTag || (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined);
if (tag && tag !== `v${expectedVersion}`) {
  throw new Error(`发布标签 ${tag} 与应用版本 v${expectedVersion} 不一致`);
}

console.log(`Cadilume 发布版本已对齐：v${expectedVersion}${tag ? ` (${tag})` : ""}`);
