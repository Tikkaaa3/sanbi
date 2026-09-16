import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "..");
const installer = path.join(repositoryRoot, "scripts", "install.mjs");

function runInstaller(piRoot, herdrRoot, ...args) {
  return spawnSync(process.execPath, [installer, "--skip-link", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, PI_AGENT_DIR: piRoot, HERDR_CONFIG_DIR: herdrRoot },
  });
}

test("repository installer manages only declared config files and backs up replacements", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sanbi-installer-"));
  const piRoot = path.join(root, "pi");
  const herdrRoot = path.join(root, "herdr");
  try {
    await mkdir(piRoot, { recursive: true });
    await writeFile(path.join(piRoot, "unrelated.json"), "preserve me\n");
    await writeFile(path.join(piRoot, "web-search.json"), JSON.stringify({ exaApiKey: "local-secret", workflow: "old" }) + "\n");

    const dryRun = runInstaller(piRoot, herdrRoot, "--dry-run");
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /Sanbi dry run complete \(12 configuration files would change\)\. No files, links, or PATH entries were modified\./);
    assert.doesNotMatch(dryRun.stdout, /installation complete/i);
    await assert.rejects(readFile(path.join(piRoot, "settings.json"), "utf8"), /ENOENT/);

    const first = runInstaller(piRoot, herdrRoot);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(piRoot, "settings.json"), "utf8")),
      JSON.parse(await readFile(path.join(repositoryRoot, "pi_config", "settings.json"), "utf8")),
    );
    assert.equal(await readFile(path.join(piRoot, "unrelated.json"), "utf8"), "preserve me\n");
    const webSearch = JSON.parse(await readFile(path.join(piRoot, "web-search.json"), "utf8"));
    assert.equal(webSearch.exaApiKey, "local-secret", "locally configured provider credentials must survive managed routing updates");
    assert.equal(webSearch.workflow, "none", "repository-managed routing settings must win");
    assert.match(await readFile(path.join(herdrRoot, "config.toml"), "utf8"), /Herdr global configuration for the Sanbi workflow/);

    await writeFile(path.join(piRoot, "settings.json"), '{"local":"old"}\n');
    const second = runInstaller(piRoot, herdrRoot);
    assert.equal(second.status, 0, second.stderr);
    const backupRuns = await readdir(path.join(piRoot, ".sanbi-backups"));
    assert.equal(backupRuns.length, 2, "the initial web-search merge and later settings replacement each receive a backup");
    let settingsBackup;
    for (const run of backupRuns) {
      try { settingsBackup = await readFile(path.join(piRoot, ".sanbi-backups", run, "pi", "settings.json"), "utf8"); } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    assert.equal(settingsBackup, '{"local":"old"}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
