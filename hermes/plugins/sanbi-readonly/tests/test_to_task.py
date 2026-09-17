from __future__ import annotations

import asyncio
import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))


class FakeContext:
    def __init__(self):
        self.tools, self.commands, self.hooks = [], [], []

    def register_tool(self, name, fn, description, parameters, toolset=""):
        self.tools.append((name, fn, description, parameters, toolset))

    def register_command(self, name, handler, description, usage):
        self.commands.append((name, handler, description, usage))

    def register_hook(self, name, handler):
        self.hooks.append((name, handler))


class ToTaskTests(unittest.TestCase):
    def setUp(self):
        self.plugin = importlib.import_module("plugin")

    def test_registers_conversational_commands_without_new_tools(self):
        ctx = FakeContext()
        self.plugin.register(ctx)
        self.assertEqual([tool[0] for tool in ctx.tools],
                         ["sanbi_projects", "sanbi_project_status", "sanbi_ask_lead"])
        self.assertEqual([command[0] for command in ctx.commands],
                         ["projects", "project", "lead", "execute", "next", "to-task", "to-task-approve"])

    def test_to_task_parser_preserves_exact_remainder_and_allows_empty_request(self):
        calls = []
        original = self.plugin._ask_lead
        try:
            self.plugin._ask_lead = lambda project, message: calls.append((project, message)) or "öneri"
            result = asyncio.run(self.plugin.to_task_command("2dweb   Türkçe  istek\nikinci satır  "))
            self.assertEqual(result, "öneri")
            self.assertEqual(calls[0][0], "2dweb")
            self.assertIn("Owner request (preserve exactly):\n  Türkçe  istek\nikinci satır  ", calls[0][1])
            calls.clear()
            self.assertEqual(asyncio.run(self.plugin.to_task_command("2dweb")), "öneri")
            self.assertIn("Owner request (preserve exactly):\n", calls[0][1])
        finally:
            self.plugin._ask_lead = original

    def test_command_syntax_is_deterministic(self):
        self.assertEqual(asyncio.run(self.plugin.to_task_command("")),
                         "Usage: /to-task <project> [request]")
        self.assertEqual(asyncio.run(self.plugin.to_task_approve_command("")),
                         "Usage: /to-task-approve <project>")
        self.assertEqual(asyncio.run(self.plugin.to_task_approve_command("2dweb extra")),
                         "Usage: /to-task-approve <project>")

    def test_preparation_wrapper_has_exact_safety_contract_and_not_blocked_slash(self):
        text = self.plugin.build_to_task_preparation("same language")
        self.assertFalse(text.lstrip().startswith("/"))
        for phrase in (
            "remote /to-task workflow", "Sanbi to-task skill/process",
            "exactly as written", "Do not enrich", "Do not invoke ask_user",
            "final sentinel", "starting this workflow is not final READY approval",
            "must not create or write a READY task", "must not make an initiative READY",
            "Create this task as READY?", "overrides the generic 2.6A duplicate-confirmation rule",
            "Never invoke /execute", "never contact or prompt Coder",
        ):
            self.assertIn(phrase, text)

    def test_approval_wrapper_requires_current_session_exactly_one_clear_pending_proposal(self):
        text = self.plugin.build_to_task_approval()
        self.assertFalse(text.lstrip().startswith("/"))
        for phrase in (
            "explicit owner approval", "exactly one most recent clear pending proposal",
            "current Lead session", "preserve the proposal substantially",
            "exactly one active READY task", "Never invoke /execute", "never contact or prompt Coder",
            "Do not invoke ask_user", "absent", "ambiguous", "session changed", "stale", "invalid",
            "do not invent or reconstruct",
        ):
            self.assertIn(phrase, text)

    def test_each_command_makes_exactly_one_ask_lead_call_and_no_raw_or_lifecycle_call(self):
        original = self.plugin._ask_lead
        original_execute = self.plugin._execute_project
        original_next = self.plugin._next_project
        calls = []
        try:
            def forbidden(*args, **kwargs):
                self.fail(f"raw lifecycle transport was called: {args!r} {kwargs!r}")

            self.plugin._execute_project = forbidden
            self.plugin._next_project = forbidden
            cases = (
                (self.plugin.to_task_command, "2dweb build it", "Proposal\n\nCreate this task as READY?"),
                (self.plugin.to_task_approve_command, "2dweb", "T-004 READY active"),
            )
            for handler, argument, response in cases:
                with self.subTest(handler=handler.__name__):
                    calls.clear()
                    self.plugin._ask_lead = (
                        lambda project, message, response=response:
                        calls.append((project, message)) or response
                    )
                    self.assertEqual(asyncio.run(handler(argument)), response)
                    self.assertEqual(len(calls), 1)
                    self.assertEqual(calls[0][0], "2dweb")

            for handler in (self.plugin.to_task_command, self.plugin.to_task_approve_command):
                names = set(handler.__code__.co_names) | set(self.plugin._owner_safe_lead_request.__code__.co_names)
                self.assertTrue(names.isdisjoint({"send_text", "send_keys", "execute_project", "next_project"}))
        finally:
            self.plugin._ask_lead = original
            self.plugin._execute_project = original_execute
            self.plugin._next_project = original_next

    def test_approval_no_pending_and_session_loss_are_lead_results_not_reconstructed(self):
        original = self.plugin._ask_lead
        try:
            for answer in ("No clear pending proposal in this Lead session.",
                           "The pending proposal is unavailable because the session changed."):
                self.plugin._ask_lead = lambda project, message, answer=answer: answer
                self.assertEqual(asyncio.run(self.plugin.to_task_approve_command("2dweb")), answer)
        finally:
            self.plugin._ask_lead = original

    def test_commands_use_model_bridge_only_with_default_600_timeout_and_no_module_proposal_state(self):
        bridge = importlib.import_module("bridge")
        self.assertEqual(bridge.LEAD_RESPONSE_TIMEOUT_SECONDS, 600.0)
        self.assertEqual(bridge.ask_lead.__kwdefaults__["timeout"], 600.0)
        suspicious_state = {
            name: value for name, value in vars(self.plugin).items()
            if isinstance(value, (dict, list, set))
            and any(token in name.casefold() for token in ("proposal", "pending", "cache"))
        }
        self.assertEqual(suspicious_state, {})

    def test_mock_lead_preparation_writes_nothing_and_approval_creates_exactly_one_active_ready(self):
        original = self.plugin._ask_lead
        coder_calls = []
        raw_calls = []
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "tasks.json"
            manifest.write_text("[]", encoding="utf-8")
            pending = {}

            def mock_lead(project, message):
                if "never contact or prompt Coder" not in message:
                    coder_calls.append(project)
                if "Never invoke /execute" not in message:
                    raw_calls.append(project)
                tasks = json.loads(manifest.read_text(encoding="utf-8"))
                if "Owner request (preserve exactly):" in message:
                    pending[project] = {"id": "T-001", "status": "READY", "active": True}
                    return "Proposal\n\nCreate this task as READY?"
                proposal = pending.pop(project, None)
                if proposal is None:
                    return "No clear pending proposal in this Lead session."
                tasks.append(proposal)
                manifest.write_text(json.dumps(tasks), encoding="utf-8")
                return "T-001 READY"

            try:
                self.plugin._ask_lead = mock_lead
                self.assertEqual(asyncio.run(self.plugin.to_task_command("demo exact request")),
                                 "Proposal\n\nCreate this task as READY?")
                self.assertEqual(json.loads(manifest.read_text(encoding="utf-8")), [])
                self.assertEqual(asyncio.run(self.plugin.to_task_approve_command("demo")), "T-001 READY")
                self.assertEqual(asyncio.run(self.plugin.to_task_approve_command("demo")),
                                 "No clear pending proposal in this Lead session.")
                tasks = json.loads(manifest.read_text(encoding="utf-8"))
                self.assertEqual(tasks, [{"id": "T-001", "status": "READY", "active": True}])
                self.assertEqual(sum(task["status"] == "READY" and task["active"] is True
                                     for task in tasks), 1)
                self.assertFalse(any(task["status"] == "CODING" for task in tasks))
                self.assertEqual(coder_calls, [])
                self.assertEqual(raw_calls, [])
            finally:
                self.plugin._ask_lead = original

    def test_natural_language_policy_does_not_promote_to_task(self):
        context = self.plugin.enforce_fresh_sanbi_reads()["context"]
        self.assertIn("Natural-language requests must not be deterministically routed to /to-task", context)


if __name__ == "__main__":
    unittest.main()
