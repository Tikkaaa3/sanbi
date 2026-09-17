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
  return spawnSync(process.execPath, [installer, "--skip-link", "--skip-hermes", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, PI_AGENT_DIR: piRoot, HERDR_CONFIG_DIR: herdrRoot },
  });
}

async function fakeHermes(root) {
  const command = path.join(root, "hermes-fake.mjs");
  const log = path.join(root, "hermes-calls.log");
  const body = `import { appendFileSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");\nif (args.slice(0, 2).join(" ") === "gateway status") console.log("No gateway service installed");\n`;
  await writeFile(command, body);
  return { command, log };
}

const expectedHermesConfigCalls = [
  "config set model.default gpt-5.6-luna",
  "config set model.provider openai-codex",
  "config set agent.reasoning_effort low",
  "config set agent.max_turns 500",
  "config set terminal.backend local",
  "config set gateway.trust_env true",
  "config set gateway.loop_watchdog true",
  "config set gateway.loop_watchdog_probe_interval_s 30",
  "config set gateway.loop_watchdog_probe_timeout_s 10",
  "config set gateway.loop_watchdog_max_strikes 3",
  "config set gateway.startup_watchdog true",
  "config set gateway.startup_watchdog_timeout_seconds 300",
];

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

test("installer provisions portable Hermes plugin without overwriting local secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sanbi-hermes-installer-"));
  const piRoot = path.join(root, "pi");
  const herdrRoot = path.join(root, "herdr");
  const hermesRoot = path.join(root, "hermes");
  try {
    await mkdir(hermesRoot, { recursive: true });
    await writeFile(path.join(hermesRoot, ".env"), "EXISTING_SECRET=keep-me\nTELEGRAM_BOT_TOKEN=old-token\n");
    await writeFile(path.join(hermesRoot, "auth.json"), '{"oauth":"preserve-me"}\n');
    await writeFile(path.join(hermesRoot, "config.yaml"), "unrelated:\n  local: preserve-me\n");
    const fake = await fakeHermes(root);
    const token = "test-token-must-not-appear";
    const result = spawnSync(process.execPath, [installer, "--skip-link"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env, PI_AGENT_DIR: piRoot, HERDR_CONFIG_DIR: herdrRoot,
        HERMES_HOME: hermesRoot, HERMES_COMMAND: process.execPath, HERMES_COMMAND_PREFIX: fake.command,
        HERMES_TELEGRAM_BOT_TOKEN: token, HERMES_TELEGRAM_ALLOWED_USERS: "12345",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
    const envFile = await readFile(path.join(hermesRoot, ".env"), "utf8");
    assert.match(envFile, /EXISTING_SECRET=keep-me/);
    assert.match(envFile, /TELEGRAM_BOT_TOKEN=old-token/);
    assert.doesNotMatch(envFile, /test-token-must-not-appear/);
    assert.match(await readFile(path.join(hermesRoot, "plugins", "sanbi-readonly", "plugin.yaml"), "utf8"), /name: sanbi-readonly/);
    assert.deepEqual(JSON.parse(await readFile(path.join(hermesRoot, "sanbi", "projects.json"), "utf8")), { projects: {} });
    const calls = await readFile(fake.log, "utf8");
    for (const call of expectedHermesConfigCalls) assert.match(calls, new RegExp(`^${call}$`, "m"));
    assert.ok(calls.indexOf(expectedHermesConfigCalls.at(-1)) < calls.indexOf("plugins doctor"), "managed config must be applied before plugin operations");
    assert.match(calls, /plugins doctor .*sanbi-readonly/);
    assert.match(calls, /plugins enable --no-allow-tool-override sanbi-readonly/);
    assert.doesNotMatch(calls, /gateway (install|restart|start)/);
    assert.equal(await readFile(path.join(hermesRoot, "auth.json"), "utf8"), '{"oauth":"preserve-me"}\n');
    assert.equal(await readFile(path.join(hermesRoot, "config.yaml"), "utf8"), "unrelated:\n  local: preserve-me\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dry run plans Hermes changes without creating HERMES_HOME or invoking Hermes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sanbi-hermes-dry-run-"));
  const hermesRoot = path.join(root, "missing-hermes-home");
  try {
    const result = spawnSync(process.execPath, [installer, "--skip-link", "--dry-run"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env, PI_AGENT_DIR: path.join(root, "pi"), HERDR_CONFIG_DIR: path.join(root, "herdr"),
        HERMES_HOME: hermesRoot, HERMES_COMMAND: path.join(root, "must-not-run"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(readFile(path.join(hermesRoot, "sanbi", "projects.json")), /ENOENT/);
    assert.match(result.stdout, /would install Hermes plugin/);
    for (const call of expectedHermesConfigCalls) assert.match(result.stdout, new RegExp(`would run hermes ${call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
