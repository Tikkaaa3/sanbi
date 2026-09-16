import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const packageRoot = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-ask-user");

test("installed ask_user schema capability is inspected when available", async (t) => {
  let packageJson;
  let source;
  try {
    packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    source = await readFile(path.join(packageRoot, "index.ts"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return t.skip("pi-ask-user is a Pi runtime package, not a repository dependency");
    throw error;
  }
  assert.match(packageJson.version, /^\d+\.\d+\.\d+/);
  const registration = source.slice(source.indexOf('name: "ask_user"'), source.indexOf('name: "ask_user"') + 5_000);
  const supportsMultipleQuestions = /questions:\s*Type\.Array/.test(registration);
  if (supportsMultipleQuestions) assert.match(registration, /questions:\s*Type\.Array/);
  else {
    assert.match(registration, /question:\s*Type\.String/);
    assert.match(registration, /Ask exactly one focused question per call/);
  }
  assert.match(registration, /allowMultiple/);
  t.diagnostic(`pi-ask-user ${packageJson.version}: multiple questions = ${supportsMultipleQuestions}`);
});

test("grilling uses dependency frontier with reliable sequential fallback for installed Ask UI", async () => {
  const skill = await readFile(new URL("../scaffold/.agent/skills/lead/grilling/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /complete current frontier/);
  assert.match(skill, /prerequisites are unresolved/);
  assert.match(skill, /currently installed Ask UI schema/);
  assert.match(skill, /exactly one `question` per invocation/);
  assert.match(skill, /ask one focused frontier question per reliable `ask_user` interaction/);
  assert.match(skill, /Do not encode several decisions into one multipart `question`/);
  assert.match(skill, /verified to expose a native multi-question schema[\s\S]*independent questions from the same current frontier together/);
  assert.match(skill, /classify the planning shape/);
  assert.match(skill, /No task or initiative has been created/);
});
