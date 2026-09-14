import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentNames, deriveProjectKey } from "../src/project.js";
import { adoptProject, CURRENT_SCAFFOLD_VERSION, upgradeProject } from "../src/scaffold.js";

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function temporary(name) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "lad-test-"));
  roots.push(parent);
  const root = path.join(parent, name);
  await mkdir(root);
  return root;
}

test("derives stable collision-resistant Herdr-safe names", () => {
  const one = deriveProjectKey("c:\\one\\same name");
  const two = deriveProjectKey("c:\\two\\same name");
  assert.notEqual(one, two);
  for (const name of Object.values(agentNames(one))) assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
});

test("adopts an empty directory and creates the canonical V1 infrastructure", async () => {
  const root = await temporary("empty-project");
  const result = await adoptProject(root);
  assert.equal(result.created.length, 11);
  assert.equal(await readFile(path.join(root, ".agent/scaffold-version"), "utf8"), `${CURRENT_SCAFFOLD_VERSION}\n`);
  assert.match(await readFile(path.join(root, ".agent/protocol.md"), "utf8"), /Protocol-Version: 1/);
  assert.match(await readFile(path.join(root, ".agent/roles/lead.md"), "utf8"), /Role-Version: 1/);
  const lifecycle = await readFile(path.join(root, ".pi/extensions/lifecycle.ts"), "utf8");
  const leadRole = await readFile(path.join(root, ".agent/roles/lead.md"), "utf8");
  const protocol = await readFile(path.join(root, ".agent/protocol.md"), "utf8");
  assert.match(lifecycle, /registerCommand\("execute"/);
  assert.match(lifecycle, /registerCommand\("next"/);
  assert.match(leadRole, /Only the deterministic `\/execute` lifecycle command may transition `READY -> CODING`/);
  assert.match(leadRole, /phrases such as “sounds good,” “okay,” or “that works”/);
  assert.match(protocol, /`BLOCKED -> CODING`/);
  assert.match(protocol, /`REVIEW -> CODING`/);
  assert.deepEqual(result.config.roles.lead, { model: "openai-codex/gpt-5.6-sol", thinking: "high" });
  assert.deepEqual(result.config.roles.coder, { model: "openai-codex/gpt-5.6-sol", thinking: "low" });
});

test("preserves existing repository and agent files on repeated adoption", async () => {
  const root = await temporary("existing-repo");
  await writeFile(path.join(root, "application.txt"), "application truth\n");
  await adoptProject(root);
  const protocol = path.join(root, ".agent/protocol.md");
  await writeFile(protocol, "custom protocol\n");
  const second = await adoptProject(root);
  assert.equal(await readFile(path.join(root, "application.txt"), "utf8"), "application truth\n");
  assert.equal(await readFile(protocol, "utf8"), "custom protocol\n");
  assert.equal(second.created.length, 0);
  assert.equal(second.updateAvailable, false);
});

test("legacy normal adoption preserves files and reports an available upgrade", async () => {
  const root = await temporary("legacy-open");
  await adoptProject(root);
  await unlink(path.join(root, ".agent/scaffold-version"));
  await writeFile(path.join(root, ".agent/protocol.md"), "legacy protocol\n");
  const reopened = await adoptProject(root);
  assert.equal(reopened.installedVersion, "legacy");
  assert.equal(reopened.updateAvailable, true);
  assert.equal(await readFile(path.join(root, ".agent/protocol.md"), "utf8"), "legacy protocol\n");
});

test("upgrade replaces only managed infrastructure, backs it up, and is idempotent", async () => {
  const root = await temporary("legacy-upgrade");
  await adoptProject(root);
  await unlink(path.join(root, ".agent/scaffold-version"));
  await writeFile(path.join(root, ".agent/protocol.md"), "legacy protocol\n");
  await writeFile(path.join(root, ".agent/project.md"), "project-owned context\n");
  await writeFile(path.join(root, "application.txt"), "application-owned\n");
  for (const directory of ["tasks", "results", "reviews", "handoffs"]) {
    await writeFile(path.join(root, ".agent", directory, "preserve.md"), `${directory} state\n`);
  }

  const upgraded = await upgradeProject(root);
  assert.equal(upgraded.changed, true);
  assert.equal(await readFile(path.join(root, ".agent/scaffold-version"), "utf8"), `${CURRENT_SCAFFOLD_VERSION}\n`);
  assert.match(await readFile(path.join(root, ".agent/protocol.md"), "utf8"), /Only the owner-invoked `\/execute`/);
  assert.match(await readFile(path.join(root, ".pi/extensions/lifecycle.ts"), "utf8"), /registerCommand\("execute"/);
  assert.match(await readFile(path.join(root, ".agent/roles/lead.md"), "utf8"), /READY` means you believe/);
  assert.equal(await readFile(path.join(root, ".agent/project.md"), "utf8"), "project-owned context\n");
  assert.equal(await readFile(path.join(root, "application.txt"), "utf8"), "application-owned\n");
  for (const directory of ["tasks", "results", "reviews", "handoffs"]) {
    assert.equal(await readFile(path.join(root, ".agent", directory, "preserve.md"), "utf8"), `${directory} state\n`);
  }
  assert.equal(await readFile(path.join(upgraded.backupDirectory, ".agent/protocol.md"), "utf8"), "legacy protocol\n");

  const again = await upgradeProject(root);
  assert.equal(again.changed, false);
  assert.deepEqual(again.replacements, []);
});

test("upgrade refuses before changing files while any task is active", async () => {
  const root = await temporary("active-upgrade");
  await adoptProject(root);
  await unlink(path.join(root, ".agent/scaffold-version"));
  const protocol = path.join(root, ".agent/protocol.md");
  await writeFile(protocol, "legacy protocol\n");
  await writeFile(path.join(root, ".agent/tasks/T-001.md"), "---\nid: T-001\nstatus: READY\nactive: true\n---\n# Active\n");
  await assert.rejects(() => upgradeProject(root), /cannot upgrade while an active task exists: T-001.md/);
  assert.equal(await readFile(protocol, "utf8"), "legacy protocol\n");
  await assert.rejects(() => readFile(path.join(root, ".agent/scaffold-version")), /ENOENT/);
});
