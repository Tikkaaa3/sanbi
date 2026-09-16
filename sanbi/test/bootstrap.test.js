import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { roleEnv } from "../src/herdr.js";
import { agentNames, deriveProjectKey } from "../src/project.js";
import { adoptProject, CURRENT_SCAFFOLD_VERSION, upgradeProject } from "../src/scaffold.js";
import { buildPiLaunchArgs, roleSkillRoots } from "../src/skills.js";

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
  assert.equal(result.created.length, 44);
  assert.equal(await readFile(path.join(root, ".agent/scaffold-version"), "utf8"), `${CURRENT_SCAFFOLD_VERSION}\n`);
  assert.match(await readFile(path.join(root, ".agent/protocol.md"), "utf8"), /Protocol-Version: 1/);
  assert.match(await readFile(path.join(root, ".agent/roles/lead.md"), "utf8"), /Role-Version: 1/);
  const lifecycle = await readFile(path.join(root, ".pi/extensions/lifecycle.ts"), "utf8");
  const subagentExtension = await readFile(path.join(root, ".pi/extensions/sanbi-subagents.ts"), "utf8");
  const leadRole = await readFile(path.join(root, ".agent/roles/lead.md"), "utf8");
  const coderRole = await readFile(path.join(root, ".agent/roles/coder.md"), "utf8");
  const protocol = await readFile(path.join(root, ".agent/protocol.md"), "utf8");
  assert.match(lifecycle, /registerCommand\("execute"/);
  assert.match(lifecycle, /registerCommand\("next"/);
  assert.match(subagentExtension, /registerCommand\("subagents"/);
  assert.match(subagentExtension, /name: "subagent_spawn"/);
  assert.doesNotMatch(subagentExtension, /from "node:child_process"/);
  assert.doesNotMatch(lifecycle, /initiatives/, "/next bootstrap must not inject full initiative content");
  assert.match(lifecycle, /pi\.on\("agent_settled"/);
  assert.match(lifecycle, /is ready for review\. Read \.agent\/results/);
  assert.match(leadRole, /Only the deterministic `\/execute` lifecycle command may transition `READY -> CODING`/);
  assert.match(leadRole, /phrases such as “sounds good,” “okay,” or “that works”/);
  assert.match(protocol, /`BLOCKED -> CODING`/);
  assert.match(protocol, /`REVIEW -> CODING`/);
  assert.match(protocol, /notifications are sent automatically by the lifecycle extension/);
  assert.match(protocol, /At most one initiative may have status `ACTIVE`/);
  assert.match(protocol, /`DRAFT`, `ACTIVE`, `PAUSED`, and `DONE`/);
  assert.match(protocol, /initiative: I-001[\s\S]*work_item: W2/);
  assert.match(coderRole, /alter initiative status, Decisions, Work Map slices/);
  assert.match(coderRole, /Report initiative-level discoveries in the result artifact/);
  assert.match(coderRole, /Coder-only `tdd` skill/);
  assert.match(coderRole, /non-implementing `diagnostic-scout` is an optional/);
  assert.match(coderRole, /mark a task `DONE`/);
  assert.match(leadRole, /Lead-only `code-review` skill/);
  assert.match(protocol, /There is no separate `REWORK` state/);
  assert.match(protocol, /`REVIEW -> CODING`/);
  assert.deepEqual(result.config.roles.lead, { model: "openai-codex/gpt-5.6-sol", thinking: "high" });
  assert.deepEqual(result.config.roles.coder, { model: "openai-codex/gpt-5.6-sol", thinking: "low" });
  assert.ok(roleEnv(result.config, "lead").includes("SANBI_ROLE=lead"));
  assert.ok(roleEnv(result.config, "coder").includes("SANBI_ROLE=coder"));
  assert.ok(roleEnv(result.config, "lead").includes("SANBI_SUBAGENT_V2=1"));
  assert.ok(roleEnv(result.config, "lead").includes("PI_SUBAGENT_MAX_DEPTH=0"));
  const expectedLead = ["code-review", "domain-modeling", "grill-me", "grill-with-docs", "grilling", "retro", "to-questionnaire", "to-spec", "to-task", "to-tickets", "wait-what", "writing-for-agents"];
  assert.deepEqual((await readdir(path.join(root, ".agent/skills/lead"))).sort(), expectedLead);
  assert.deepEqual((await readdir(path.join(root, ".agent/skills/coder"))).sort(), ["diagnosing-bugs", "tdd"]);
  assert.deepEqual(await readdir(path.join(root, ".agent/skills/shared")), ["codebase-design"]);
  assert.deepEqual(await readdir(path.join(root, ".agent/initiatives")), [], "new adoption must not create a fake initiative");
  assert.deepEqual(await readdir(path.join(root, ".agent/subagents/shared")), ["researcher.md", "scout.md"]);
  assert.deepEqual(await readdir(path.join(root, ".agent/subagents/lead")), ["reviewer.md"]);
  assert.deepEqual(await readdir(path.join(root, ".agent/subagents/coder")), ["diagnostic-scout.md"]);
  const initiativeTemplate = await readFile(path.join(root, ".agent/templates/initiative.md"), "utf8");
  assert.match(initiativeTemplate, /^id: I-000$/m);
  assert.match(initiativeTemplate, /^status: DRAFT$/m);
  assert.match(initiativeTemplate, /No work items yet/);
  assert.doesNotMatch(initiativeTemplate, /^### W1/m);
  const taskTemplate = await readFile(path.join(root, ".agent/templates/task.md"), "utf8");
  assert.match(taskTemplate, /# initiative: I-001/);
  assert.match(taskTemplate, /# work_item: W1/);
  const reviewTemplate = await readFile(path.join(root, ".agent/templates/review.md"), "utf8");
  assert.match(reviewTemplate, /### Contract Axis/);
  assert.match(reviewTemplate, /### Standards Axis/);
  assert.match(reviewTemplate, /same task\/session to `CODING`/);
  const resultTemplate = await readFile(path.join(root, ".agent/templates/result.md"), "utf8");
  assert.match(resultTemplate, /focused red command\/result, then green/);
  assert.match(resultTemplate, /## TDD Evidence/);
  assert.match(resultTemplate, /RED:[\s\S]*expected missing or incorrect behavior/);
  assert.match(resultTemplate, /GREEN:[\s\S]*brief behavior implemented/);
  assert.match(resultTemplate, /TDD not applicable/);
  assert.match(resultTemplate, /supported root cause/);
  const handoffTemplate = await readFile(path.join(root, ".agent/templates/handoff.md"), "utf8");
  assert.match(handoffTemplate, /## Active Initiative/);
  assert.match(handoffTemplate, /Canonical artifact:/);
  assert.doesNotMatch(handoffTemplate, /## Problem\n|## Desired Outcome\n/, "handoff must point to rather than embed an initiative");
  assert.match(leadRole, /write application source code/);
  assert.match(leadRole, /modify Sanbi-managed/);
  assert.match(leadRole, /mark the task `DONE` as the final durable completion step/);
  assert.match(protocol, /\.agent\/skills\/\*\*/);
});

test("loads canonical Lead and shared skill roots without changing Pi model configuration", async () => {
  const root = await temporary("role-skills");
  const adopted = await adoptProject(root);
  const leadRoot = path.join(root, ".agent/skills/lead");
  const coderRoot = path.join(root, ".agent/skills/coder");
  const sharedRoot = path.join(root, ".agent/skills/shared");
  assert.deepEqual(await roleSkillRoots(root, "lead"), [leadRoot, sharedRoot]);
  assert.deepEqual(await roleSkillRoots(root, "coder"), [coderRoot, sharedRoot]);

  const leadArgs = await buildPiLaunchArgs(adopted, "lead");
  const coderArgs = await buildPiLaunchArgs(adopted, "coder");
  assert.deepEqual(leadArgs, ["--approve", "--thinking", "high", "--model", "openai-codex/gpt-5.6-sol", "--skill", leadRoot, "--skill", sharedRoot]);
  assert.deepEqual(coderArgs, ["--approve", "--thinking", "low", "--model", "openai-codex/gpt-5.6-sol", "--skill", coderRoot, "--skill", sharedRoot]);
  assert.equal(leadArgs.includes(coderRoot), false);
  assert.equal(coderArgs.includes(leadRoot), false);
  assert.equal(leadArgs.includes(sharedRoot), true, "Lead must receive codebase-design through the shared root");
  assert.equal(coderArgs.includes(sharedRoot), true, "Coder must receive codebase-design through the shared root");
  assert.equal(leadArgs.includes("--no-skills"), false);
  assert.equal(coderArgs.includes("--no-skills"), false);
  assert.equal(leadArgs.some((arg) => arg.endsWith(".md")), false, "supporting references must not be passed independently");

  for (const role of ["lead", "coder", "shared"]) {
    const roleRoot = path.join(root, ".agent/skills", role);
    for (const entry of await readdir(roleRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillText = await readFile(path.join(roleRoot, entry.name, "SKILL.md"), "utf8");
      assert.match(skillText, /^---\r?\n[\s\S]*?^name:\s*[a-z0-9-]+\s*$/m);
      assert.match(skillText, /^description:\s*.+$/m);
    }
  }
  const userOnly = ["grill-me", "grill-with-docs", "wait-what", "to-questionnaire", "retro", "to-spec", "to-task", "to-tickets"];
  for (const name of userOnly) {
    assert.match(await readFile(path.join(leadRoot, name, "SKILL.md"), "utf8"), /^disable-model-invocation:\s*true$/m, `${name} must be user-invoked only`);
  }
  for (const name of ["grilling", "domain-modeling", "writing-for-agents", "code-review"]) {
    assert.doesNotMatch(await readFile(path.join(leadRoot, name, "SKILL.md"), "utf8"), /^disable-model-invocation:/m, `${name} must remain model-invokable`);
  }
  for (const name of ["tdd", "diagnosing-bugs"]) {
    assert.doesNotMatch(await readFile(path.join(coderRoot, name, "SKILL.md"), "utf8"), /^disable-model-invocation:/m, `${name} must remain model-invokable`);
  }
  assert.doesNotMatch(await readFile(path.join(sharedRoot, "codebase-design/SKILL.md"), "utf8"), /^disable-model-invocation:/m);
  assert.match(await readFile(path.join(leadRoot, "grilling/SKILL.md"), "utf8"), /No task or initiative has been created/);
  assert.match(await readFile(path.join(leadRoot, "domain-modeling/SKILL.md"), "utf8"), /`CONTEXT\.md` is a domain glossary only/);
  assert.match(await readFile(path.join(leadRoot, "to-questionnaire/SKILL.md"), "utf8"), /docs\/questionnaires\/<slug>\.md/);
  const toSpec = await readFile(path.join(leadRoot, "to-spec/SKILL.md"), "utf8");
  assert.match(toSpec, /\.agent\/initiatives\/I-xxx-<slug>\.md/);
  assert.doesNotMatch(toSpec, /GitHub Issues|Linear/i);
  assert.match(toSpec, /Do not[\s\S]*issue tracker/i);
  assert.match(toSpec, /Never write `\.agent\/tasks\/\*\*`/);
  const toTickets = await readFile(path.join(leadRoot, "to-tickets/SKILL.md"), "utf8");
  assert.match(toTickets, /IDs are initiative-local planning IDs, never `T-xxx` task IDs/);
  assert.match(toTickets, /Never create or bulk-create `\.agent\/tasks\/\*\*`/);
  assert.match(toTickets, /Expand:[\s\S]*Migrate:[\s\S]*Contract:/);
  assert.equal(coderArgs.includes(path.join(leadRoot, "to-spec")), false);
  assert.equal(coderArgs.includes(path.join(leadRoot, "to-tickets")), false);

  const tdd = await readFile(path.join(coderRoot, "tdd/SKILL.md"), "utf8");
  assert.match(tdd, /existing `CODING → BLOCKED` flow and ask Lead/);
  assert.match(tdd, /Do not ask the owner directly/i);
  assert.match(tdd, /before implementing that behavior[\s\S]*observe RED[\s\S]*only then implement[\s\S]*observe GREEN/i);
  assert.match(tdd, /pure\/domain logic[\s\S]*component behavior[\s\S]*bug regressions/i);
  assert.match(tdd, /config-only changes[\s\S]*Do not invent a meaningless test/i);
  assert.match(tdd, /Focused TDD commands do not replace final task verification/);
  const diagnosing = await readFile(path.join(coderRoot, "diagnosing-bugs/SKILL.md"), "utf8");
  assert.match(diagnosing, /`CODING → BLOCKED` flow/);
  assert.match(diagnosing, /non-implementing `diagnostic-scout`/);
  assert.match(diagnosing, /must not implement the fix/);
  const codeReview = await readFile(path.join(leadRoot, "code-review/SKILL.md"), "utf8");
  assert.match(codeReview, /binding specification is `\.agent\/tasks\/<task-id>\.md`/);
  assert.doesNotMatch(codeReview, /GitHub Issues|Linear|docs\/agents\/issue-tracker/i);
  assert.match(codeReview, /\.agent\/reviews\/<task-id>\.md/);
  assert.match(codeReview, /REVIEW → update review artifact → sanbi_signal_coder\(rework\) → CODING/);
  assert.doesNotMatch(codeReview, /REWORK state is supported|REVIEW → REWORK/);
  assert.match(codeReview, /never modifies application or test source/);
  assert.match(codeReview, /`VCS: none`: do not run Git status, diff, or log/);
  assert.match(codeReview, /Do not yet exhaustively read every changed implementation\/test file/);
  assert.match(codeReview, /Promptly launch two fresh application-non-writing `reviewer` subagents/);
  assert.match(codeReview, /While reviewers run:[\s\S]*deterministic verification/);
  assert.match(codeReview, /Targeted Lead inspection/);
  assert.match(codeReview, /Optional paths must receive one quiet existence\/listing check/);
  assert.match(codeReview, /Reviewer disagreement routes to targeted Lead inspection/);
  assert.match(codeReview, /genuinely tiny review, direct Lead review may skip subagents/);
  assert.match(codeReview, /On Round 2\+/);
  assert.equal(leadArgs.includes(coderRoot), false, "Lead must not receive Coder-only execution skills");
  assert.equal(coderArgs.includes(leadRoot), false, "Coder must not receive Lead-only code-review");

  const retro = await readFile(path.join(leadRoot, "retro/SKILL.md"), "utf8");
  assert.match(retro, /does not automatically mutate Sanbi-managed/);
  for (const reference of [
    path.join(leadRoot, "domain-modeling/CONTEXT-FORMAT.md"),
    path.join(leadRoot, "domain-modeling/ADR-FORMAT.md"),
    path.join(leadRoot, "writing-for-agents/SKILL-MECHANICS.md"),
    path.join(sharedRoot, "codebase-design/DEEPENING.md"),
    path.join(sharedRoot, "codebase-design/DESIGN-IT-TWICE.md"),
    path.join(coderRoot, "tdd/tests.md"),
    path.join(coderRoot, "tdd/mocking.md"),
  ]) assert.ok((await readFile(reference, "utf8")).length > 0);
  assert.match(await readFile(path.join(root, ".agent/skills/LICENSE.mattpocock"), "utf8"), /Copyright \(c\) 2026 Matt Pocock/);
});

test("preserves existing repository and agent files on repeated adoption", async () => {
  const root = await temporary("existing-repo");
  await writeFile(path.join(root, "application.txt"), "application truth\n");
  await adoptProject(root);
  const protocol = path.join(root, ".agent/protocol.md");
  await writeFile(protocol, "custom protocol\n");
  await rm(path.join(root, ".agent/initiatives"), { recursive: true });
  const second = await adoptProject(root);
  assert.equal(await readFile(path.join(root, "application.txt"), "utf8"), "application truth\n");
  assert.equal(await readFile(protocol, "utf8"), "custom protocol\n");
  assert.equal(second.created.length, 0);
  assert.equal(second.updateAvailable, false);
  assert.deepEqual(await readdir(path.join(root, ".agent/initiatives")), [], "current scaffold reopening must restore a missing empty infrastructure directory");
});

test("legacy normal adoption preserves files and reports an available upgrade", async () => {
  const root = await temporary("legacy-open");
  await adoptProject(root);
  await unlink(path.join(root, ".agent/scaffold-version"));
  await rm(path.join(root, ".agent/skills"), { recursive: true });
  await rm(path.join(root, ".agent/initiatives"), { recursive: true });
  await rm(path.join(root, ".agent/subagents"), { recursive: true });
  await unlink(path.join(root, ".agent/templates/initiative.md"));
  await unlink(path.join(root, ".pi/extensions/sanbi-subagents.ts"));
  await writeFile(path.join(root, ".agent/protocol.md"), "legacy protocol\n");
  const reopened = await adoptProject(root);
  assert.equal(reopened.installedVersion, "legacy");
  assert.equal(reopened.updateAvailable, true);
  assert.equal(await readFile(path.join(root, ".agent/protocol.md"), "utf8"), "legacy protocol\n");
  await assert.rejects(() => readdir(path.join(root, ".agent/skills")), /ENOENT/, "normal sanbi must not add newer managed skill infrastructure");
  await assert.rejects(() => readdir(path.join(root, ".agent/initiatives")), /ENOENT/, "normal sanbi must leave versioned initiative-directory migration to upgrade");
  await assert.rejects(() => readdir(path.join(root, ".agent/subagents")), /ENOENT/, "normal sanbi must not partially install Subagent V2");
  await assert.rejects(() => readFile(path.join(root, ".pi/extensions/sanbi-subagents.ts")), /ENOENT/);
  await assert.rejects(() => readFile(path.join(root, ".agent/templates/initiative.md")), /ENOENT/, "normal sanbi must not partially install a newer template");
});

test("upgrade replaces only managed infrastructure, backs it up, and is idempotent", async () => {
  const root = await temporary("legacy-upgrade");
  await adoptProject(root);
  await writeFile(path.join(root, ".agent/scaffold-version"), "8\n");
  await rm(path.join(root, ".agent/skills"), { recursive: true });
  await rm(path.join(root, ".agent/initiatives"), { recursive: true });
  await rm(path.join(root, ".agent/subagents"), { recursive: true });
  await mkdir(path.join(root, ".agent/subagents/retired"), { recursive: true });
  await mkdir(path.join(root, ".agent/subagents/lead"), { recursive: true });
  await writeFile(path.join(root, ".agent/subagents/retired/obsolete.md"), "obsolete project definition\n");
  await writeFile(path.join(root, ".agent/subagents/lead/old-reviewer.md"), "obsolete managed definition\n");
  await unlink(path.join(root, ".agent/templates/initiative.md"));
  await unlink(path.join(root, ".pi/extensions/sanbi-subagents.ts"));
  await mkdir(path.join(root, ".agent/skills/lead/grilling"), { recursive: true });
  await writeFile(path.join(root, ".agent/skills/lead/grilling/SKILL.md"), "legacy managed grilling\n");
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
  assert.match(await readFile(path.join(root, ".agent/roles/lead.md"), "utf8"), /`READY` means the owner explicitly approved `\/to-task`/);
  assert.equal(await readFile(path.join(root, ".agent/project.md"), "utf8"), "project-owned context\n");
  assert.equal(await readFile(path.join(root, "application.txt"), "utf8"), "application-owned\n");
  assert.deepEqual(upgraded.createdDirectories, [".agent/skills/coder", ".agent/skills/shared", ".agent/initiatives", ".agent/subagents/shared", ".agent/subagents/coder"]);
  assert.deepEqual((await readdir(path.join(root, ".agent/skills/coder"))).sort(), ["diagnosing-bugs", "tdd"]);
  assert.deepEqual((await readdir(path.join(root, ".agent/skills/lead"))).sort(), ["code-review", "domain-modeling", "grill-me", "grill-with-docs", "grilling", "retro", "to-questionnaire", "to-spec", "to-task", "to-tickets", "wait-what", "writing-for-agents"]);
  assert.deepEqual(await readdir(path.join(root, ".agent/skills/shared")), ["codebase-design"]);
  assert.deepEqual(await readdir(path.join(root, ".agent/initiatives")), []);
  assert.deepEqual(await readdir(path.join(root, ".agent/subagents/shared")), ["researcher.md", "scout.md"]);
  assert.deepEqual(upgraded.retiredFiles, [path.join(".agent", "subagents", "lead", "old-reviewer.md")]);
  await assert.rejects(() => readFile(path.join(root, ".agent/subagents/lead/old-reviewer.md")), /ENOENT/);
  assert.equal(await readFile(path.join(upgraded.backupDirectory, ".agent/subagents/lead/old-reviewer.md"), "utf8"), "obsolete managed definition\n");
  assert.equal(await readFile(path.join(root, ".agent/subagents/retired/obsolete.md"), "utf8"), "obsolete project definition\n", "non-registry sibling directories are project-owned and preserved");
  assert.match(await readFile(path.join(root, ".pi/extensions/sanbi-subagents.ts"), "utf8"), /createAgentSession/);
  assert.match(await readFile(path.join(root, ".pi/sanbi/subagent-ui.js"), "utf8"), /semanticTool/);
  assert.match(await readFile(path.join(root, ".pi/sanbi/runtime-temp.js"), "utf8"), /\.sanbi-runtime-owned/);
  assert.match(await readFile(path.join(root, ".pi/sanbi/runtime-process.js"), "utf8"), /startRuntimeProcess/);
  assert.match(await readFile(path.join(root, ".agent/templates/initiative.md"), "utf8"), /^id: I-000$/m);
  for (const directory of ["tasks", "results", "reviews", "handoffs"]) {
    assert.equal(await readFile(path.join(root, ".agent", directory, "preserve.md"), "utf8"), `${directory} state\n`);
  }
  assert.equal(await readFile(path.join(upgraded.backupDirectory, ".agent/protocol.md"), "utf8"), "legacy protocol\n");
  assert.equal(await readFile(path.join(upgraded.backupDirectory, ".agent/skills/lead/grilling/SKILL.md"), "utf8"), "legacy managed grilling\n");
  assert.match(await readFile(path.join(root, ".agent/skills/lead/grilling/SKILL.md"), "utf8"), /^name: grilling$/m);

  const again = await upgradeProject(root);
  assert.equal(again.changed, false);
  assert.deepEqual(again.replacements, []);
});

test("upgrade preserves existing project-owned initiative content", async () => {
  const root = await temporary("initiative-upgrade");
  await adoptProject(root);
  await writeFile(path.join(root, ".agent/scaffold-version"), "8\n");
  const initiativePath = path.join(root, ".agent/initiatives/I-001-relay.md");
  const initiative = "---\nid: I-001\ntitle: Relay\nstatus: ACTIVE\n---\n\n# Relay\n\n## Work Map\n\n### W1 — Thin relay\n\n**Status:** PLANNED\n";
  await writeFile(initiativePath, initiative);
  const upgraded = await upgradeProject(root);
  assert.equal(upgraded.changed, true);
  assert.equal(await readFile(initiativePath, "utf8"), initiative);
});

test("upgrade refuses before changing files while any task is active", async () => {
  const root = await temporary("active-upgrade");
  await adoptProject(root);
  await unlink(path.join(root, ".agent/scaffold-version"));
  const protocol = path.join(root, ".agent/protocol.md");
  await writeFile(protocol, "legacy protocol\n");
  await writeFile(path.join(root, ".agent/tasks/T-001.md"), "---\nid: T-001\nstatus: READY\nactive: \"true\"\n---\n# Active\n");
  await assert.rejects(() => upgradeProject(root), /cannot upgrade while an active task exists: T-001.md/);
  assert.equal(await readFile(protocol, "utf8"), "legacy protocol\n");
  await assert.rejects(() => readFile(path.join(root, ".agent/scaffold-version")), /ENOENT/);
});
