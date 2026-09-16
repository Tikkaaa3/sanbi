import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function skill(relative) { return readFile(new URL(`../scaffold/.agent/skills/${relative}`, import.meta.url), "utf8"); }

test("optional context paths use quiet existence checks and required artifacts remain strict", async () => {
  const lead = await readFile(new URL("../scaffold/.agent/roles/lead.md", import.meta.url), "utf8");
  const spec = await skill("lead/to-spec/SKILL.md");
  const tickets = await skill("lead/to-tickets/SKILL.md");
  const domain = await skill("lead/domain-modeling/SKILL.md");
  const review = await skill("lead/code-review/SKILL.md");
  assert.match(lead, /optional context paths[\s\S]*one quiet existence\/listing check/i);
  assert.match(lead, /Absence is normal: skip silently[\s\S]*rather than probing again/);
  assert.match(spec, /Quietly check optional root `CONTEXT\.md` and `docs\/adr\/` once/);
  assert.match(spec, /absence is normal, produces no tool error, and is not probed again/);
  assert.match(tickets, /Quietly check optional `CONTEXT\.md` and `docs\/adr\/` once/);
  assert.match(domain, /if absent, skip without a tool error or repeated probe/);
  assert.match(review, /missing required task\/result or explicitly linked initiative is an error/);
  assert.match(review, /read relevant content only when present|consult only what is relevant/);
});
