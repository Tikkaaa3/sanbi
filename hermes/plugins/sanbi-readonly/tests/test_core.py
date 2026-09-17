from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))

import core


TASK = """---
id: {id}
title: {title}
status: {status}
active: {active}
initiative: I-001
work_item: {work}
---
body
"""
INITIATIVE = """---
id: I-001
title: Main initiative
status: ACTIVE
---
# Main
## Work Map
### W1 — First
**Status:** DONE  
**Sanbi task:** T-001  
**Blocked by:** None  
### W2 — Second
**Status:** PLANNED  
**Blocked by:** W1  
### W3 — Third
**Status:** PLANNED  
**Blocked by:** W2  
"""
PROJECT = """# Project Context
## Identity
**Name:** Not established
**Purpose:** Test purpose.
## Current Technology
- Python 3.11
- SQLite
## Version Control
**VCS:** Git
"""


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def make_project(root: Path) -> Path:
    agent = root / ".agent"
    write(agent / "project.md", PROJECT)
    write(agent / "tasks" / "T-001.md", TASK.format(id="T-001", title="Done", status="DONE", active="false", work="W1"))
    write(agent / "tasks" / "T-002.md", TASK.format(id="T-002", title="Ready", status="READY", active="true", work="W2"))
    write(agent / "initiatives" / "I-001.md", INITIATIVE)
    write(agent / "config.json", json.dumps({"herdr": {"leadAgent": "lead-id", "coderAgent": "coder-id"}}))
    return root


def make_registry(path: Path, projects: dict) -> Path:
    write(path, json.dumps({"projects": projects}))
    return path


def make_workspace_registry(path: Path, roots: list[Path], projects: dict | None = None) -> Path:
    write(path, json.dumps({"workspace_roots": [str(root) for root in roots],
                            "projects": projects or {}}))
    return path


def tree_proof(root: Path):
    out = []
    for p in sorted(root.rglob("*"), key=lambda x: str(x).lower()):
        stat = p.stat()
        digest = hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
        out.append((str(p.relative_to(root)), p.is_dir(), stat.st_size, stat.st_mtime_ns, digest))
    return out


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp_obj = tempfile.TemporaryDirectory()
        self.tmp = Path(self.tmp_obj.name)
        self.project = make_project(self.tmp / "project")
        self.registry = make_registry(self.tmp / "projects.json", {"demo": {"path": str(self.project)}})

    def tearDown(self):
        self.tmp_obj.cleanup()

    def assertRegistryError(self, registry: Path, needle: str):
        with self.assertRaisesRegex(core.SanbiError, needle):
            core.load_registry(registry)

    def test_lists_valid_registry_deterministically(self):
        make_registry(self.registry, {"zeta": {"path": str(self.project)}, "alpha": {"path": str(self.tmp / "other")}})
        make_project(self.tmp / "other")
        self.assertEqual([p["alias"] for p in core.load_registry(self.registry)], ["alpha", "zeta"])

    def test_missing_registry_fails_closed(self):
        self.registry.unlink()
        self.assertRegistryError(self.registry, "does not exist")

    def test_invalid_registry_json_fails_closed(self):
        self.registry.write_text("{", encoding="utf-8")
        self.assertRegistryError(self.registry, "valid JSON")

    def test_registry_root_and_projects_must_be_objects(self):
        self.registry.write_text("[]", encoding="utf-8")
        self.assertRegistryError(self.registry, "root")
        self.registry.write_text('{"projects": []}', encoding="utf-8")
        self.assertRegistryError(self.registry, "projects")

    def test_alias_must_be_safe_and_nonempty(self):
        for alias in ("", "../bad", "two words", "a/b"):
            make_registry(self.registry, {alias: {"path": str(self.project)}})
            self.assertRegistryError(self.registry, "alias")

    def test_project_path_must_be_absolute_existing_directory_with_agent(self):
        cases = ["relative", str(self.tmp / "missing"), str(self.tmp / "plain")]
        (self.tmp / "plain").mkdir()
        for value in cases:
            make_registry(self.registry, {"demo": {"path": value}})
            self.assertRegistryError(self.registry, "path|directory|.agent")

    def test_canonical_duplicate_paths_fail_closed(self):
        make_registry(self.registry, {"one": {"path": str(self.project)}, "two": {"path": str(self.project / ".")}})
        self.assertRegistryError(self.registry, "duplicate")

    def test_raw_path_is_never_accepted_as_project(self):
        with self.assertRaisesRegex(core.SanbiError, "Unknown project alias"):
            core.read_project_status(str(self.project), self.registry, runtime_reader=lambda *_: {})

    def test_required_task_frontmatter(self):
        write(self.project / ".agent/tasks/T-002.md", "---\nid: T-002\ntitle: broken\n---\n")
        with self.assertRaisesRegex(core.SanbiError, "required field"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_task_status_is_restricted(self):
        text = TASK.format(id="T-002", title="Bad", status="RUNNING", active="true", work="W2")
        write(self.project / ".agent/tasks/T-002.md", text)
        with self.assertRaisesRegex(core.SanbiError, "task status"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_task_active_is_strict_boolean(self):
        text = TASK.format(id="T-002", title="Bad", status="READY", active='"true"', work="W2")
        write(self.project / ".agent/tasks/T-002.md", text)
        with self.assertRaisesRegex(core.SanbiError, "active"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_at_most_one_active_task(self):
        write(self.project / ".agent/tasks/T-001.md", TASK.format(id="T-001", title="One", status="CODING", active="true", work="W1"))
        with self.assertRaisesRegex(core.SanbiError, "active task"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_duplicate_task_ids_fail_closed(self):
        write(self.project / ".agent/tasks/other.md", TASK.format(id="T-002", title="Dupe", status="DONE", active="false", work="W9"))
        with self.assertRaisesRegex(core.SanbiError, "duplicate task"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_last_completed_is_highest_numeric_task_id(self):
        write(self.project / ".agent/tasks/T-010.md", TASK.format(id="T-010", title="Later", status="DONE", active="false", work="W9"))
        result = core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})
        self.assertEqual(result["workflow"]["lastCompletedTask"]["id"], "T-010")

    def test_initiative_frontmatter_status_and_single_active_are_validated(self):
        write(self.project / ".agent/initiatives/I-002.md", INITIATIVE.replace("I-001", "I-002"))
        with self.assertRaisesRegex(core.SanbiError, "active initiative"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})
        (self.project / ".agent/initiatives/I-002.md").unlink()
        write(self.project / ".agent/initiatives/I-001.md", INITIATIVE.replace("status: ACTIVE", "status: INVALID"))
        with self.assertRaisesRegex(core.SanbiError, "initiative status"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_work_map_duplicate_ids_fail_closed(self):
        write(self.project / ".agent/initiatives/I-001.md", INITIATIVE + "\n### W2 — Duplicate\n**Status:** DONE\n**Blocked by:** None\n")
        with self.assertRaisesRegex(core.SanbiError, "duplicate work"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_work_map_status_is_restricted(self):
        write(self.project / ".agent/initiatives/I-001.md", INITIATIVE.replace("PLANNED", "INVALID", 1))
        with self.assertRaisesRegex(core.SanbiError, "work status"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_unknown_work_blocker_fails_closed(self):
        write(self.project / ".agent/initiatives/I-001.md", INITIATIVE.replace("**Blocked by:** W1", "**Blocked by:** W404", 1))
        with self.assertRaisesRegex(core.SanbiError, "unknown blocker"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_ready_work_requires_sanbi_task_reference(self):
        write(self.project / ".agent/initiatives/I-001.md", INITIATIVE.replace("**Status:** PLANNED", "**Status:** READY", 1))
        with self.assertRaisesRegex(core.SanbiError, "READY.*Sanbi"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_sanbi_task_reference_must_be_known_task_id(self):
        text = INITIATIVE.replace("**Sanbi task:** T-001", "**Sanbi task:** missing")
        write(self.project / ".agent/initiatives/I-001.md", text)
        with self.assertRaisesRegex(core.SanbiError, "Sanbi Task reference"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_duplicate_frontmatter_keys_fail_closed(self):
        text = TASK.format(id="T-002", title="Bad", status="READY", active="true", work="W2")
        write(self.project / ".agent/tasks/T-002.md", text.replace("status: READY", "status: READY\nstatus: DONE"))
        with self.assertRaisesRegex(core.SanbiError, "malformed task frontmatter"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_done_missing_linkage_is_warning_not_fatal(self):
        text = INITIATIVE.replace("**Sanbi task:** T-001  \n", "")
        write(self.project / ".agent/initiatives/I-001.md", text)
        result = core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})
        self.assertTrue(any("W1" in warning for warning in result["warnings"]))

    def test_frontier_returns_all_unblocked_planned_items(self):
        result = core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})
        self.assertEqual([x["id"] for x in result["workflow"]["frontier"]], ["W2"])
        self.assertEqual([x["id"] for x in result["workflow"]["workItems"]], ["W1", "W2", "W3"])

    def test_identity_falls_back_to_alias_and_extracts_purpose_technology_vcs(self):
        result = core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})
        project = result["project"]
        self.assertEqual(set(project), {"alias", "displayName", "purpose", "currentTechnology"})
        self.assertEqual(project["displayName"], "demo")
        self.assertEqual(project["purpose"], "Test purpose.")
        self.assertEqual(project["currentTechnology"], ["Python 3.11", "SQLite"])
        self.assertEqual(result["repository"], {"path": str(self.project.resolve()), "vcs": "Git"})
        self.assertEqual(set(result), {"project", "workflow", "runtime", "repository", "warnings"})

    def test_herdr_exact_agent_matching_online_offline(self):
        snapshot = {"agents": [{"agent_id": "lead-id"}, {"agent_id": "lead-id-extra"}]}
        runtime = core.runtime_status(self.project, snapshot_reader=lambda: snapshot)
        self.assertEqual(runtime["lead"], {"agentId": "lead-id", "status": "online"})
        self.assertEqual(runtime["coder"], {"agentId": "coder-id", "status": "offline"})

    def test_herdr_errors_are_unavailable_without_breaking_durable_status(self):
        def broken():
            raise subprocess.TimeoutExpired("herdr", 2)
        result = core.read_project_status("demo", self.registry, runtime_reader=lambda p: core.runtime_status(p, snapshot_reader=broken))
        self.assertEqual(result["runtime"]["lead"]["status"], "unavailable")
        self.assertEqual(result["workflow"]["activeTask"]["id"], "T-002")

    def test_status_read_preserves_full_project_tree_metadata_and_hashes(self):
        before = tree_proof(self.project)
        core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})
        after = tree_proof(self.project)
        self.assertEqual(after, before)

    def test_json_tools_return_concise_errors_and_deterministic_formatter(self):
        payload = json.loads(core.project_status_json("missing", self.registry))
        self.assertIn("error", payload)
        self.assertIn("Unknown project alias", core.format_status(payload))

    def test_registry_rejects_unknown_top_level_and_entry_fields(self):
        write(self.registry, json.dumps({"projects": {"demo": {"path": str(self.project)}}, "extra": True}))
        self.assertRegistryError(self.registry, "unknown registry field")
        make_registry(self.registry, {"demo": {"path": str(self.project), "label": "nope"}})
        self.assertRegistryError(self.registry, "unknown field.*label")

    def test_unknown_alias_lists_registered_aliases(self):
        with self.assertRaisesRegex(core.SanbiError, r"registered aliases: demo"):
            core.read_project_status("missing", self.registry, runtime_reader=lambda *_: {})

    def test_active_initiative_requires_work_map(self):
        write(self.project / ".agent/initiatives/I-001.md", INITIATIVE.replace("## Work Map", "## Plan"))
        with self.assertRaisesRegex(core.SanbiError, "missing Work Map"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_work_headings_outside_work_map_are_ignored(self):
        text = INITIATIVE + "\n## Notes\n### W2 — Not a duplicate\n**Status:** INVALID\n**Blocked by:** W404\n"
        write(self.project / ".agent/initiatives/I-001.md", text)
        result = core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})
        self.assertEqual([item["id"] for item in result["workflow"]["workItems"]], ["W1", "W2", "W3"])

    def test_work_map_allows_current_sanbi_outcome_and_verification_fields(self):
        text = INITIATIVE.replace(
            "**Blocked by:** W1  ",
            "**Blocked by:** W1  \n**Outcome:** Deliver the item.  \n**Verification:** Prove it deterministically.",
            1,
        )
        write(self.project / ".agent/initiatives/I-001.md", text)
        result = core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})
        self.assertEqual([item["id"] for item in result["workflow"]["workItems"]], ["W1", "W2", "W3"])

    def test_work_map_requires_at_least_one_well_formed_item(self):
        text = INITIATIVE.split("### W1", 1)[0] + "Intro only\n"
        write(self.project / ".agent/initiatives/I-001.md", text)
        with self.assertRaisesRegex(core.SanbiError, "at least one well-formed"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_duplicate_work_metadata_fails_closed(self):
        text = INITIATIVE.replace("**Status:** PLANNED", "**Status:** PLANNED\n**Status:** DONE", 1)
        write(self.project / ".agent/initiatives/I-001.md", text)
        with self.assertRaisesRegex(core.SanbiError, "duplicate.*Status"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_unknown_and_malformed_work_metadata_fail_closed(self):
        for replacement, needle in (("**Owner:** Alice", "unknown work metadata"),
                                    ("**Status** PLANNED", "malformed work metadata")):
            text = INITIATIVE.replace("**Status:** PLANNED", replacement, 1)
            write(self.project / ".agent/initiatives/I-001.md", text)
            with self.assertRaisesRegex(core.SanbiError, needle):
                core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_work_metadata_outside_an_item_fails_closed(self):
        text = INITIATIVE.replace("## Work Map", "## Work Map\n**Owner:** nobody", 1)
        write(self.project / ".agent/initiatives/I-001.md", text)
        with self.assertRaisesRegex(core.SanbiError, "unknown work metadata"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_malformed_work_heading_in_work_map_fails_closed(self):
        write(self.project / ".agent/initiatives/I-001.md", INITIATIVE.replace("### W1 — First", "### W1 - First"))
        with self.assertRaisesRegex(core.SanbiError, "malformed work item heading"):
            core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})

    def test_frontier_handles_none_done_not_done_and_multiple_blockers(self):
        extra = """### W4 — No blockers
**Status:** PLANNED
**Blocked by:** None
### W5 — Multiple done blockers
**Status:** PLANNED
**Blocked by:** W1, W6
### W6 — Also done
**Status:** DONE
**Blocked by:** None
### W7 — One blocker not done
**Status:** PLANNED
**Blocked by:** W1, W2
"""
        write(self.project / ".agent/initiatives/I-001.md", INITIATIVE + extra)
        result = core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})
        self.assertEqual([x["id"] for x in result["workflow"]["frontier"]], ["W2", "W4", "W5"])

    def test_zero_and_exactly_one_active_task_are_supported(self):
        result = core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})
        self.assertEqual(result["workflow"]["activeTask"]["id"], "T-002")
        write(self.project / ".agent/tasks/T-002.md", TASK.format(id="T-002", title="Ready", status="READY", active="false", work="W2"))
        result = core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})
        self.assertIsNone(result["workflow"]["activeTask"])

    def test_vcs_is_authoritative_and_absent_is_unknown_without_git_inspection(self):
        (self.project / ".git").mkdir()
        write(self.project / ".agent/project.md", PROJECT.replace("**VCS:** Git\n", ""))
        result = core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})
        self.assertEqual(result["repository"], {"path": str(self.project.resolve()), "vcs": "unknown"})
        write(self.project / ".agent/project.md", PROJECT.replace("**VCS:** Git", "**VCS:** Fossil"))
        result = core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})
        self.assertEqual(result["repository"]["vcs"], "Fossil")

    def test_complete_project_command_format(self):
        payload = core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {
            "lead": {"agentId": "lead-id", "status": "online"},
            "coder": {"agentId": "coder-id", "status": "offline"},
        })
        self.assertEqual(core.format_status(payload), "\n".join([
            "demo", "Initiative: I-001 — Main initiative [ACTIVE]", "Implementation:",
            "- Active: T-002 — Ready [READY]", "- Last completed: T-001 — Done [DONE]",
            "Frontier:", "- W2 — Second", "Agents:", "- Lead: online", "- Coder: offline",
            "Repository:", f"- Path: {self.project.resolve()}", "- VCS: Git", "Warnings: none",
        ]))

    def test_project_format_handles_none_sections_and_warnings(self):
        payload = core.read_project_status("demo", self.registry, runtime_reader=lambda *_: {})
        payload["workflow"].update(activeInitiative=None, activeTask=None, lastCompletedTask=None, frontier=[])
        payload["warnings"] = ["careful"]
        rendered = core.format_status(payload)
        for expected in ("Initiative: none", "- Active: no active task", "- Last completed: none",
                         "Frontier: none", "Warnings:\n- careful"):
            self.assertIn(expected, rendered)

    def test_project_summaries_use_marker_only_without_runtime_or_status_probe(self):
        second = make_project(self.tmp / "second")
        make_registry(self.registry, {"demo": {"path": str(self.project)}, "other": {"path": str(second)}})
        calls = []
        def reader(alias, registry_path, runtime_reader):
            calls.append(alias)
            return core.read_project_status(alias, registry_path, runtime_reader=lambda *_: {})
        payload = core.read_projects_status(self.registry, status_reader=reader, runtime_reader=lambda *_: {})
        self.assertEqual(calls, [])
        rendered = core.format_projects(payload)
        self.assertIn("demo  initialized", rendered)
        self.assertIn("other  initialized", rendered)

    def test_project_summary_list_does_not_probe_detailed_status(self):
        calls = []
        original = core.read_project_status
        def reader(alias, registry_path, runtime_reader):
            calls.append(alias)
            return original(alias, registry_path, runtime_reader=lambda *_: {})
        try:
            core.read_project_status = reader
            payload = core.read_projects_status(self.registry, runtime_reader=lambda *_: {})
        finally:
            core.read_project_status = original
        self.assertEqual(calls, [])
        self.assertEqual(payload["projects"][0]["alias"], "demo")

    def test_registry_default_prefers_hermes_home_environment(self):
        old = os.environ.get("HERMES_HOME")
        try:
            os.environ["HERMES_HOME"] = str(self.tmp / "profile")
            self.assertEqual(core.default_registry_path(), self.tmp / "profile" / "sanbi" / "projects.json")
        finally:
            if old is None:
                os.environ.pop("HERMES_HOME", None)
            else:
                os.environ["HERMES_HOME"] = old

    def test_workspace_discovers_direct_children_only_and_ignores_files(self):
        workspace = self.tmp / "Workspace"
        (workspace / "alpha" / "nested").mkdir(parents=True)
        (workspace / "beta").mkdir()
        write(workspace / "not-a-directory.txt", "x")
        make_workspace_registry(self.registry, [workspace])
        found = core.discover_projects(self.registry)
        self.assertEqual([item["alias"] for item in found["projects"]], ["alpha", "beta"])
        self.assertEqual({item["source"] for item in found["projects"]}, {"workspace"})

    def test_workspace_discovery_is_fresh_for_create_delete_and_initialization(self):
        workspace = self.tmp / "Workspace"; workspace.mkdir()
        make_workspace_registry(self.registry, [workspace])
        self.assertEqual(core.discover_projects(self.registry)["projects"], [])
        project = workspace / "newgame"; project.mkdir()
        first = core.discover_projects(self.registry)["projects"]
        self.assertFalse(first[0]["initialized"])
        write(project / ".agent/config.json", "{}")
        self.assertTrue(core.discover_projects(self.registry)["projects"][0]["initialized"])
        (project / ".agent/config.json").unlink(); (project / ".agent").rmdir(); project.rmdir()
        self.assertEqual(core.discover_projects(self.registry)["projects"], [])

    def test_explicit_alias_precedes_dynamic_case_insensitively(self):
        workspace = self.tmp / "Workspace"; dynamic = workspace / "Game"; dynamic.mkdir(parents=True)
        explicit = make_project(self.tmp / "external")
        make_workspace_registry(self.registry, [workspace], {"game": {"path": str(explicit)}})
        resolved = core.resolve_project("GAME", self.registry)
        self.assertEqual(resolved["source"], "explicit")
        self.assertEqual(Path(resolved["path"]), explicit.resolve())
        self.assertEqual([item["alias"] for item in core.discover_projects(self.registry)["projects"]], ["game"])

    def test_explicit_aliases_cannot_differ_only_by_case(self):
        second = make_project(self.tmp / "second")
        make_registry(self.registry, {"Foo": {"path": str(self.project)}, "foo": {"path": str(second)}})
        self.assertRegistryError(self.registry, "case-insensitive duplicate")

    def test_multiple_root_alias_collision_is_ambiguous_and_fails_closed(self):
        roots = [self.tmp / "a", self.tmp / "b"]
        for root in roots: (root / "foo").mkdir(parents=True)
        make_workspace_registry(self.registry, roots)
        found = core.discover_projects(self.registry)
        self.assertEqual(found["projects"], [])
        self.assertEqual(found["ambiguous"][0]["alias"], "foo")
        with self.assertRaisesRegex(core.SanbiError, 'alias "foo" is ambiguous'):
            core.resolve_project("FOO", self.registry)
        payload = json.loads(core.projects_json(self.registry))
        self.assertEqual(payload["ambiguous"][0]["alias"], "foo")

    def test_dynamic_alias_rejects_paths_and_traversal(self):
        workspace = self.tmp / "Workspace"; (workspace / "alpha").mkdir(parents=True)
        make_workspace_registry(self.registry, [workspace])
        for alias in ("../foo", "..\\foo", r"C:\foo", r"\\host\share", "alpha/beta", "alpha\\beta", ".", ".."):
            with self.subTest(alias=alias), self.assertRaisesRegex(core.SanbiError, "unsafe project alias"):
                core.resolve_project(alias, self.registry)

    def test_duplicate_roots_are_deduplicated_and_invalid_roots_warn(self):
        workspace = self.tmp / "Workspace"; (workspace / "alpha").mkdir(parents=True)
        missing = self.tmp / "missing"
        write(self.registry, json.dumps({"workspace_roots": [str(workspace), str(workspace / "."), str(missing)], "projects": {}}))
        found = core.discover_projects(self.registry)
        self.assertEqual([item["alias"] for item in found["projects"]], ["alpha"])
        self.assertEqual(len(found["warnings"]), 1)

    def test_workspace_roots_schema_is_validated(self):
        for roots in ("not-a-list", [""], [3], ["relative"]):
            write(self.registry, json.dumps({"workspace_roots": roots, "projects": {}}))
            self.assertRegistryError(self.registry, "workspace_roots")

    def test_uninitialized_dynamic_status_is_minimal_and_passive(self):
        workspace = self.tmp / "Workspace"; project = workspace / "newgame"; project.mkdir(parents=True)
        make_workspace_registry(self.registry, [workspace])
        calls = []
        payload = core.read_project_status("NEWGAME", self.registry,
                                           runtime_reader=lambda path: calls.append(path) or {})
        self.assertEqual(payload["project"]["displayName"], "newgame")
        self.assertFalse(payload["project"]["initialized"])
        self.assertEqual(payload["runtime"], {"lead": {"agentId": None, "status": "offline"},
                                               "coder": {"agentId": None, "status": "offline"}})
        self.assertIsNone(payload["workflow"])
        self.assertEqual(calls, [])
        self.assertIn("Sanbi: not initialized", core.format_status(payload))

    def test_dynamic_alias_with_spaces_resolves_end_to_end(self):
        workspace = self.tmp / "Workspace"; project = workspace / "My Project"; project.mkdir(parents=True)
        make_workspace_registry(self.registry, [workspace])
        resolved = core.resolve_project("my project", self.registry)
        self.assertEqual(resolved["alias"], "My Project")
        self.assertEqual(Path(resolved["path"]), project.resolve())

    def test_symlink_escape_is_not_discovered_when_supported(self):
        workspace = self.tmp / "Workspace"; workspace.mkdir()
        outside = self.tmp / "outside"; outside.mkdir()
        link = workspace / "escape"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("directory symlinks are unavailable")
        make_workspace_registry(self.registry, [workspace])
        self.assertEqual(core.discover_projects(self.registry)["projects"], [])


if __name__ == "__main__":
    unittest.main()
