import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adoptProject } from "../src/scaffold.js";

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "sanbi-planning-v2-")); roots.push(root); await adoptProject(root); return root; }
const skill = (root, name) => readFile(path.join(root, ".agent/skills/lead", name, "SKILL.md"), "utf8");

test("grilling reaches classification and stops without planning artifacts", async () => {
  const root = await fixture();
  const grilling = await skill(root, "grilling");
  assert.match(grilling, /Never write `\.agent\/tasks\/\*\*` or `\.agent\/initiatives\/\*\*`/);
  assert.doesNotMatch(grilling, /may lead to[\s\S]*task draft/i);
  assert.match(grilling, /likely standalone task/);
  assert.match(grilling, /likely initiative/);
  assert.match(grilling, /Recommended next step: \/to-task/);
  assert.match(grilling, /Recommended next step: \/to-spec/);
  assert.match(grilling, /No task or initiative has been created/);
  assert.match(grilling, /exactly one `question` per invocation[\s\S]*one focused frontier question/i);
  assert.deepEqual(await readdir(path.join(root, ".agent/tasks")), []);
  assert.deepEqual(await readdir(path.join(root, ".agent/initiatives")), []);
});

test("grill-with-docs composes canonical skills and cannot create tasks or initiatives", async () => {
  const root = await fixture();
  const wrapper = await skill(root, "grill-with-docs");
  assert.match(wrapper, /\.agent\/skills\/lead\/grilling\/SKILL\.md/);
  assert.match(wrapper, /\.agent\/skills\/lead\/domain-modeling\/SKILL\.md/);
  assert.match(wrapper, /Before asking the first question, read and apply both canonical files directly/);
  assert.match(wrapper, /Never create or modify `\.agent\/tasks\/\*\*` or `\.agent\/initiatives\/\*\*`/);
  assert.match(wrapper, /recommend `\/to-task` or `\/to-spec`/);
  assert.match(wrapper, /STOP/);
  assert.deepEqual(await readdir(path.join(root, ".agent/tasks")), []);
  assert.deepEqual(await readdir(path.join(root, ".agent/initiatives")), []);
});

test("grill-me stays stateless", async () => {
  const root = await fixture();
  const text = await skill(root, "grill-me");
  assert.match(text, /Never create or modify tasks, initiatives, `CONTEXT\.md`, ADRs, `\.agent\/project\.md`/);
  assert.match(text, /likely be a standalone task or initiative/);
});

test("to-spec and to-tickets remain explicit owner transitions that create no tasks", async () => {
  const root = await fixture();
  const spec = await skill(root, "to-spec");
  const tickets = await skill(root, "to-tickets");
  for (const text of [spec, tickets]) assert.match(text, /^disable-model-invocation:\s*true$/m);
  assert.match(spec, /Never write `\.agent\/tasks\/\*\*`/);
  assert.match(spec, /Leave `Work Map` empty/);
  assert.match(spec, /exact owner approval then supplies the required activation intent/);
  assert.match(spec, /premature never-started task/);
  assert.match(spec, /cancel\/remove[\s\S]*keep the task[\s\S]*stop and inspect manually/i);
  assert.match(spec, /Never delete or deactivate a task without that explicit choice/);
  assert.match(tickets, /only skill responsible for detailed initiative decomposition/i);
  assert.match(tickets, /Optimize for coherent fresh-context implementation slices, not few tickets/);
  assert.match(tickets, /If yes, split it in the proposed Work Map/);
  assert.match(tickets, /Only unblocked `PLANNED` slices form the selectable frontier/);
  assert.match(tickets, /Do not mark an item `READY` merely because it is unblocked or approved/);
  assert.match(tickets, /requires explicit owner activation intent before `\/to-task`/);
  assert.match(tickets, /No task has been created/);
  assert.match(tickets, /select one item and use \/to-task/);
  assert.deepEqual(await readdir(path.join(root, ".agent/tasks")), []);
});

test("to-task is user-only and creates at most one owner-approved right-sized task", async () => {
  const root = await fixture();
  const text = await skill(root, "to-task");
  assert.match(text, /^disable-model-invocation:\s*true$/m);
  assert.match(text, /only normal skill-level path for creating a new `\.agent\/tasks\/T-xxx\.md`/);
  assert.match(text, /Mode A — standalone/);
  assert.match(text, /Mode B — initiative work item/);
  assert.match(text, /more than one item is unblocked[\s\S]*use `ask_user`[\s\S]*which \*\*one\*\*/);
  assert.match(text, /Never choose silently when multiple candidates exist/);
  assert.match(text, /Could this work naturally be split into two or more independently useful, independently verifiable outcomes/);
  assert.match(text, /This is too broad for one Sanbi task/);
  assert.match(text, /Do not silently split broad work into multiple task files/);
  assert.match(text, /steering-direction-facing change is a plausible standalone task/);
  assert.match(text, /category cues, event feedback, a new-best celebration, audio, and mute persistence is initiative-shaped/);
  assert.match(text, /Create this task as READY\?/);
  assert.match(text, /Only an affirmative response to this proposal permits creation/);
  assert.match(text, /Write one `\.agent\/tasks\/T-xxx\.md`[\s\S]*`active: true` and `status: READY`/);
  assert.match(text, /update exactly the selected Work Map item to `READY` and add `Sanbi task: T-xxx`/);
  assert.match(text, /Do not promote any other frontier item/);
  assert.match(text, /exactly one new active READY task with correct linkage/);
  assert.match(text, /`initiative: I-xxx` and `work_item: Wn`/);
  assert.match(text, /\/execute` remains the only execution authorization/);
});

test("all canonical planning instructions preserve owner transition authority", async () => {
  const root = await fixture();
  const protocol = await readFile(path.join(root, ".agent/protocol.md"), "utf8");
  const lead = await readFile(path.join(root, ".agent/roles/lead.md"), "utf8");
  assert.match(protocol, /Natural-language agreement is not `\/to-spec`, `\/to-tickets`, `\/to-task`, or `\/execute`/);
  assert.match(protocol, /discussion → optional grilling → owner \/to-task → one READY task → owner \/execute/);
  assert.match(protocol, /owner \/to-spec → initiative → owner \/to-tickets → Work Map → owner selects one item through \/to-task/);
  assert.match(lead, /create a task automatically after discussion, grilling, domain modeling, architecture discussion/);
  assert.match(lead, /create one task only through owner-invoked `\/to-task`/);
  assert.match(lead, /If yes, it is too broad for one task/);
  assert.match(lead, /asks `Create this task as READY\?`, and writes only after explicit owner approval/);
  const lifecycle = await readFile(path.join(root, ".pi/extensions/lifecycle.ts"), "utf8");
  assert.match(lifecycle, /registerCommand\("execute"/);
  assert.match(lifecycle, /transition\(authorized, "READY", "CODING"\)/);
  assert.match(lifecycle, /registerCommand\("next"/);
  assert.doesNotMatch(lifecycle, /to-task|to-spec|to-tickets/);
  assert.match(await readFile(path.join(root, ".pi/extensions/sanbi-subagents.ts"), "utf8"), /name: "subagent_spawn"/);
});

test("initiative and task templates are compressed and just-in-time", async () => {
  const root = await fixture();
  const initiative = await readFile(path.join(root, ".agent/templates/initiative.md"), "utf8");
  const task = await readFile(path.join(root, ".agent/templates/task.md"), "utf8");
  assert.match(initiative, /No work items yet/);
  assert.doesNotMatch(initiative, /^### W1/m);
  assert.match(initiative, /`PLANNED` until an actual task is created through `\/to-task`/);
  assert.match(task, /^# initiative: I-001$/m);
  assert.match(task, /^# work_item: W1$/m);
  assert.match(task, /higher-level product decisions and initiative context remain canonical/);
  assert.match(task, /rather than repeating its full prose/);
});
