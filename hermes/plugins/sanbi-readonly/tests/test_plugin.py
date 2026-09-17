from __future__ import annotations

import asyncio
import importlib
import json

import sys
import unittest
import logging
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))


class FakeContext:
    def __init__(self) -> None:
        self.tools = []
        self.commands = []
        self.hooks = []

    def register_tool(self, name, fn, description, parameters, toolset=""):
        self.tools.append((name, fn, description, parameters, toolset))

    def register_command(self, name, handler, description, usage):
        self.commands.append((name, handler, description, usage))

    def register_hook(self, name, handler):
        self.hooks.append((name, handler))


class CurrentHermesContext:
    def __init__(self) -> None:
        self.tools = []
        self.commands = []
        self.hooks = []

    def register_tool(self, name, toolset, schema, handler, description=""):
        self.tools.append({"name": name, "toolset": toolset, "schema": schema, "handler": handler})

    def register_command(self, name, handler, description="", args_hint=""):
        self.commands.append({"name": name, "handler": handler, "args_hint": args_hint})

    def register_hook(self, name, handler):
        self.hooks.append({"name": name, "handler": handler})


class RegistrationTests(unittest.TestCase):
    def test_registers_milestone_two_lead_tool_and_command(self):
        plugin = importlib.import_module("plugin")
        ctx = FakeContext()

        plugin.register(ctx)

        self.assertEqual([t[0] for t in ctx.tools], ["sanbi_projects", "sanbi_project_status", "sanbi_ask_lead"])
        self.assertEqual([t[4] for t in ctx.tools], ["sanbi_readonly"] * 3)
        self.assertEqual([c[0] for c in ctx.commands],
                         ["projects", "project", "lead", "execute", "next", "to-task", "to-task-approve"])
        lead_schema = ctx.tools[2][3]
        self.assertEqual(lead_schema["required"], ["project", "message"])
        self.assertFalse(lead_schema["additionalProperties"])
        self.assertIn("explicit", ctx.tools[2][2].lower())
        self.assertIn("Lead", ctx.tools[2][2])
        self.assertEqual([h[0] for h in ctx.hooks], ["pre_llm_call"])
        self.assertEqual(ctx.tools[0][3], {"type": "object", "properties": {}, "additionalProperties": False})
        self.assertEqual(ctx.tools[1][3]["required"], ["project"])
        self.assertFalse(ctx.tools[1][3]["additionalProperties"])


    def test_conversation_bridge_has_no_lifecycle_authorization_escape_hatch(self):
        plugin = importlib.import_module("plugin")
        bridge = importlib.import_module("bridge")
        original = bridge.ask_lead
        calls = []
        try:
            self.assertNotIn("_ask_lifecycle_lead", vars(plugin))
            with self.assertRaisesRegex(bridge.BridgeError, "workflow command"):
                bridge.ask_lead("2dweb", "/execute")
            self.assertEqual(calls, [])
        finally:
            bridge.ask_lead = original


    def test_current_hermes_schema_api_adapts_tool_handlers(self):
        plugin = importlib.import_module("plugin")
        old_projects = plugin.sanbi_projects
        old_status = plugin.sanbi_project_status

        try:
            plugin.sanbi_projects = lambda: '{"projects": []}'
            plugin.sanbi_project_status = lambda project: json.dumps({"project": project})

            ctx = CurrentHermesContext()
            plugin.register(ctx)
            self.assertEqual([tool["name"] for tool in ctx.tools], ["sanbi_projects", "sanbi_project_status", "sanbi_ask_lead"])
            self.assertEqual(ctx.tools[0]["schema"]["parameters"]["additionalProperties"], False)
            self.assertEqual(json.loads(ctx.tools[0]["handler"]({})), {"projects": []})
            self.assertEqual(json.loads(ctx.tools[1]["handler"]({"project": "demo"})), {"project": "demo"})

        finally:
            plugin.sanbi_projects = old_projects
            plugin.sanbi_project_status = old_status


    def test_tool_descriptions_require_fresh_reads_not_chat_memory(self):
        plugin = importlib.import_module("plugin")
        ctx = FakeContext()
        plugin.register(ctx)
        for tool in ctx.tools[:2]:
            description = tool[2]
            self.assertIn("MUST call", description)
            self.assertIn("never answer", description)
            self.assertIn("chat memory", description)

    def test_pre_llm_hook_requires_a_fresh_status_call_each_relevant_turn(self):
        plugin = importlib.import_module("plugin")
        result = plugin.enforce_fresh_sanbi_reads(user_message="silah compiler işi bitti mi?")
        context = result["context"]
        self.assertIn("during THIS turn", context)
        self.assertIn("Never answer from chat history", context)
        self.assertIn("sanbi_project_status", context)
        self.assertIn("explicitly asks", context)
        self.assertIn("sanbi_ask_lead", context)
        self.assertIn("Status questions", context)

    def test_pre_llm_hook_makes_natural_language_lead_routing_messenger_only(self):
        plugin = importlib.import_module("plugin")
        context = plugin.enforce_fresh_sanbi_reads()["context"]
        for phrase in ("act only as a messenger", "Do not translate", "do not change its language",
                       "Do not rewrite it into a better prompt", "project alias", "project reasoning"):
            self.assertIn(phrase, context)

    def test_pre_llm_hook_forbids_substantive_enrichment(self):
        plugin = importlib.import_module("plugin")
        context = plugin.enforce_fresh_sanbi_reads()["context"]
        for phrase in ("analysis", "recommendations", "reviews", "requirements", "technical details",
                       "architecture", "examples", "assumptions", "acceptance criteria",
                       "testing requirements", "improvements"):
            self.assertIn(phrase, context)

    def test_pre_llm_hook_preserves_discussion_and_authorization_strength(self):
        plugin = importlib.import_module("plugin")
        context = plugin.enforce_fresh_sanbi_reads()["context"]
        self.assertIn("must not become an instruction or authorization", context)
        self.assertIn("must not be weakened into a question or suggestion", context)

    def test_lead_command_keeps_deterministic_payload_untouched(self):
        plugin = importlib.import_module("plugin")
        original = plugin.sanbi_ask_lead
        captured = []
        try:
            plugin.sanbi_ask_lead = lambda project, message: captured.append((project, message)) or "ok"
            self.assertEqual(asyncio.run(plugin.lead_command("2dweb Tell me what W3 needs.")),
                             "2dweb Lead:\n\nok")
            self.assertEqual(captured, [("2dweb", "Tell me what W3 needs.")])
        finally:
            plugin.sanbi_ask_lead = original


    def test_projects_command_performs_fresh_status_reads(self):
        plugin = importlib.import_module("plugin")
        original = plugin._core
        class FakeCore:
            calls = 0
            @classmethod
            def projects_status_json(cls):
                cls.calls += 1
                return json.dumps({"projects": []})
            @staticmethod
            def format_projects(payload):
                return "Projects: none"
        try:
            plugin._core = lambda: FakeCore
            self.assertEqual(asyncio.run(plugin.projects_command(None)), "Projects: none")
            self.assertEqual(FakeCore.calls, 1)
        finally:
            plugin._core = original

    def test_status_and_projects_paths_never_enter_lead_activation(self):
        plugin = importlib.import_module("plugin")
        original_core = plugin._core
        original_ask = plugin._ask_lead
        class FakeCore:
            @staticmethod
            def projects_json(): return '{"projects":[]}'
            @staticmethod
            def project_status_json(project): return json.dumps({"project": project})
        try:
            plugin._core = lambda: FakeCore
            plugin._ask_lead = lambda *args: (_ for _ in ()).throw(AssertionError("activated"))
            self.assertEqual(json.loads(plugin.sanbi_projects()), {"projects": []})
            self.assertEqual(json.loads(plugin.sanbi_project_status("demo")), {"project": "demo"})
        finally:
            plugin._core = original_core
            plugin._ask_lead = original_ask


    def test_lead_command_returns_full_answer_for_native_gateway_splitting(self):
        plugin = importlib.import_module("plugin")
        original = plugin.sanbi_ask_lead
        long_answer = "x" * 10000
        class Context:
            args = "demo discuss the design"
        try:
            plugin.sanbi_ask_lead = lambda project, message: long_answer if (project, message) == ("demo", "discuss the design") else "wrong"
            self.assertEqual(asyncio.run(plugin.lead_command(Context())), "demo Lead:\n\n" + long_answer)
        finally:
            plugin.sanbi_ask_lead = original

    def test_tool_and_command_return_concise_owner_safe_bridge_errors(self):
        plugin = importlib.import_module("plugin")
        bridge = importlib.import_module("bridge")
        original = plugin._ask_lead
        try:
            plugin._ask_lead = lambda *args: (_ for _ in ()).throw(bridge.BridgeError("safe concise error"))
            self.assertEqual(plugin.sanbi_ask_lead("demo", "secret owner text"), "Lead request failed: safe concise error")
            self.assertEqual(asyncio.run(plugin.lead_command("demo secret owner text")), "Lead request failed: safe concise error")
        finally:
            plugin._ask_lead = original

    def test_unexpected_lead_errors_are_generic_and_logged_without_content(self):
        plugin = importlib.import_module("plugin")
        original = plugin._ask_lead
        records = []
        class Handler(logging.Handler):
            def emit(self, record): records.append(self.format(record))
        handler = Handler(); plugin._LOGGER.addHandler(handler)
        try:
            plugin._ask_lead = lambda *args: (_ for _ in ()).throw(RuntimeError("secret answer credential"))
            self.assertEqual(plugin.sanbi_ask_lead("demo", "owner secret"), "Lead request failed unexpectedly. Inspect local logs.")
            self.assertFalse(any("secret" in record or "credential" in record for record in records))
        finally:
            plugin._LOGGER.removeHandler(handler); plugin._ask_lead = original


if __name__ == "__main__":
    unittest.main()
