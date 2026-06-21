#!/usr/bin/env node
"use strict";

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const allowedReleaseTypes = new Set(["patch", "minor", "major"]);
const usageMessage = "Usage: npm run release -- <patch|minor|major>";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const expectedRepoSlug = "bestimmaa/roon-mcp";
const expectedRemoteUrl = `git@bitbucket.org:${expectedRepoSlug}.git`;
const releaseFiles = ["package.json", "package-lock.json"];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio || "pipe",
    shell: process.platform === "win32"
  });
}

function ensureReleaseType(type) {
  if (!allowedReleaseTypes.has(type)) {
    throw new Error(usageMessage);
  }
}

function ensureCleanWorktree() {
  try {
    run("git", ["diff", "--quiet"]);
    run("git", ["diff", "--cached", "--quiet"]);
    const untrackedFiles = run("git", ["ls-files", "--others", "--exclude-standard"]).trim();
    if (untrackedFiles !== "") {
      throw new Error("Release requires a clean git worktree.");
    }
  } catch {
    throw new Error("Release requires a clean git worktree.");
  }
}

function getCurrentBranch() {
  return run("git", ["branch", "--show-current"]).trim();
}

function getHeadCommit(ref = "HEAD") {
  return run("git", ["rev-parse", ref]).trim();
}

function hasGitRef(ref) {
  try {
    getHeadCommit(ref);
    return true;
  } catch {
    return false;
  }
}

function getNextVersion(releaseType, currentVersion = pkg.version) {
  const [major, minor, patch] = currentVersion.split(".").map((segment) => Number.parseInt(segment, 10));

  if (releaseType === "major") {
    return `${major + 1}.0.0`;
  }

  if (releaseType === "minor") {
    return `${major}.${minor + 1}.0`;
  }

  return `${major}.${minor}.${patch + 1}`;
}

function ensureAttachedHeadBranch() {
  const branch = getCurrentBranch();

  if (!branch) {
    throw new Error("Release requires an attached HEAD branch.");
  }

  return branch;
}

function ensureMainBranch(branch) {
  if (branch !== "main") {
    throw new Error("Release requires the main branch.");
  }

  return branch;
}

function ensureChangelogExists() {
  const changelogPath = path.resolve(process.cwd(), "CHANGELOG.md");

  if (!existsSync(changelogPath)) {
    throw new Error("Release requires CHANGELOG.md. Update it before running npm run release.");
  }

  return changelogPath;
}

function ensureChangelogEntry(version) {
  const changelogPath = ensureChangelogExists();
  const changelog = readFileSync(changelogPath, "utf8");

  if (!changelog.includes(`## [${version}]`)) {
    throw new Error(`Release requires CHANGELOG.md to include an entry for ${version}. Update it before running npm run release.`);
  }
}

function isExpectedRemote(url) {
  return /(?:bitbucket\.org|github\.com)[:/]bestimmaa\/roon-mcp(?:\.git)?$/i.test(url);
}

function restoreReleaseFiles() {
  const restorableFiles = releaseFiles.filter((file) => existsSync(path.resolve(process.cwd(), file)));

  if (restorableFiles.length === 0) {
    return true;
  }

  run("git", ["restore", "--source=HEAD", "--staged", "--worktree", ...restorableFiles]);
  return true;
}

function rollbackRelease(version, options = {}) {
  const { shouldDeleteTag = true } = options;
  let rollbackSucceeded = true;

  if (shouldDeleteTag) {
    try {
      run("git", ["tag", "-d", version]);
    } catch {
      rollbackSucceeded = false;
    }
  }

  try {
    run("git", ["reset", "--soft", "HEAD~1"]);
  } catch {
    rollbackSucceeded = false;
  }

  try {
    restoreReleaseFiles();
  } catch {
    rollbackSucceeded = false;
  }

  return rollbackSucceeded;
}

function hasCreatedReleaseState(preReleaseHead, expectedTag) {
  try {
    const currentHead = getHeadCommit();
    return currentHead !== preReleaseHead;
  } catch {}

  return false;
}

function packRelease() {
  const packOutput = run(npmCommand, ["pack", "--json"]);
  const [packResult] = JSON.parse(packOutput);

  if (!packResult || typeof packResult.filename !== "string" || packResult.filename === "") {
    throw new Error("npm pack did not report an output filename.");
  }

  return path.resolve(process.cwd(), packResult.filename);
}

function cleanupPackArtifact(packPath) {
  let cleanupSucceeded = true;

  if (packPath && existsSync(packPath)) {
    try {
      unlinkSync(packPath);
    } catch {
      cleanupSucceeded = false;
    }
  }

  return cleanupSucceeded;
}

function main(argv = process.argv.slice(2)) {
  const releaseType = argv[0];
  ensureReleaseType(releaseType);
  ensureCleanWorktree();
  const expectedVersion = getNextVersion(releaseType);
  ensureChangelogEntry(expectedVersion);
  const branch = ensureMainBranch(ensureAttachedHeadBranch());
  const preReleaseHead = getHeadCommit();
  const expectedTag = `v${expectedVersion}`;
  const hadExpectedTagBeforeRelease = hasGitRef(expectedTag);

  run(npmCommand, ["test"], { stdio: "inherit" });
  let versionStarted = false;
  let version;
  let packPath;
  let cleanupSucceeded = true;

  try {
    versionStarted = true;
    version = run(npmCommand, ["version", releaseType, "-m", "chore(release): %s"]).trim();
    packPath = packRelease();
    cleanupSucceeded = cleanupPackArtifact(packPath);
    if (!cleanupSucceeded) {
      throw new Error("pack artifact cleanup failed");
    }
  } catch (error) {
    cleanupSucceeded = cleanupPackArtifact(packPath) && cleanupSucceeded;

    if (versionStarted) {
      const releaseStateCreated = hasCreatedReleaseState(preReleaseHead, expectedTag);
      if (!releaseStateCreated) {
        restoreReleaseFiles();
        throw new Error(`Release failed before creating git release state: ${error.message || error}`);
      }

      const rollbackSucceeded = rollbackRelease(version || expectedTag, {
        shouldDeleteTag: !hadExpectedTagBeforeRelease
      });
      if (rollbackSucceeded && cleanupSucceeded) {
        throw new Error(`Release failed after version bump and was rolled back: ${error.message || error}`);
      }

      throw new Error(`Release failed after version bump and rollback was incomplete: ${error.message || error}`);
    }

    throw error;
  }

  console.log(`Release prepared: ${version}`);
  console.log("Next: git push origin main:main --follow-tags");
  console.log("Next: npm publish --access public");
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

export {
  ensureCleanWorktree,
  ensureReleaseType,
  isExpectedRemote,
  expectedRemoteUrl,
  main
};
