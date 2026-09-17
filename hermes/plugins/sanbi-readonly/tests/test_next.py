from __future__ import annotations

import asyncio
import importlib
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))

import bridge
from tests.test_execute import Clock, ExecuteTransport, agent


FULL = ("The /next command was sent to the demo Lead.\n"
        "T-007 is now inactive.\n"
        "Both configured agent sessions changed.")


class SnapshotTransport(ExecuteTransport):
    def __init__(self, root: Path, final_sessions=("lead-session", "coder-session"), **kwargs):
        super().__init__(root, **kwargs)
        self.final_sessions = final_sessions
        self.dispatched = False

    def send_keys(self, target, *keys):
        super().send_keys(target, *keys)
        self.dispatched = True

    def snapshot(self):
        if self.dispatched:
            self.lead["agent_session"]["value"] = self.final_sessions[0]
            self.coder["agent_session"]["value"] = self.final_sessions[1]
        return super().snapshot()


class NextTests(unittest.TestCase):
    def setUp(self):
        self.tmp_obj = tempfile.TemporaryDirectory()
        self.tmp = Path(self.tmp_obj.name)
        self.root = self.tmp / "project"
        (self.root / ".agent").mkdir(parents=True)
        (self.root / ".agent/config.json").write_text(json.dumps({
            "project": {"key": "demo-key"},
            "herdr": {"leadAgent": "lead-id", "coderAgent": "coder-id"},
        }), encoding="utf-8")
        self.registry = self.tmp / "projects.json"
        self.registry.write_text(json.dumps({"projects": {"demo": {"path": str(self.root)}}}), encoding="utf-8")
        bridge._IN_FLIGHT.clear()

    def tearDown(self):
        bridge._IN_FLIGHT.clear()
        self.tmp_obj.cleanup()

    def run_next(self, transport, records, clock=None):
        values = iter(records)
        last = [None]
        def task_reader(project):
            try:
                last[0] = next(values)
            except StopIteration:
                pass
            return last[0]
        clock = clock or Clock()
        return bridge.next_project(
            "demo", registry_path=self.registry, transport=transport,
            task_reader=task_reader, monotonic=clock.monotonic, sleep=clock.sleep,
            activation_token_factory=lambda: "ActToken123",
        )

    @staticmethod
    def tasks(active=True, task_id="T-007"):
        return [{"id": task_id, "active": active, "status": "DONE", "title": "Task"}]

    def test_full_snapshot_dispatches_exact_raw_next_once_for_full_ninety_seconds(self):
        clock = Clock()
        t = SnapshotTransport(self.root, final_sessions=("lead-new", "coder-new"))
        result = self.run_next(t, (self.tasks(True), self.tasks(False)), clock)
        self.assertEqual(result, FULL)
        self.assertEqual([c for c in t.calls if isinstance(c, tuple) and c[0] == "send_text"], [("send_text", "w:l", "/next")])
        self.assertEqual([c for c in t.calls if isinstance(c, tuple) and c[0] == "send_keys"], [("send_keys", "lead-id", "enter")])
        self.assertEqual(clock.value, 90.0)
        self.assertFalse(any(isinstance(c, tuple) and c[0] in {"prompt", "read"} for c in t.calls))

    def test_partial_and_unchanged_snapshots_have_exact_distinct_classifications(self):
        cases = [
            (("lead-session", "coder-new"), True,
             "T-007 is still active, but the Coder session changed.\n"
             "The runtime appears to be in a partial transition. Check /project demo before sending /next again."),
            (("lead-session", "coder-new"), False,
             "T-007 is inactive and the Coder session changed, but the Lead session did not rotate.\n"
             "Check /project demo before taking another lifecycle action."),
            (("lead-new", "coder-session"), True,
             "T-007 is still active and the Lead session changed, but the Coder session did not rotate.\n"
             "This is a partial or ambiguous transition. Check /project demo before taking another lifecycle action."),
            (("lead-new", "coder-session"), False,
             "T-007 is inactive and the Lead session changed, but the Coder session did not rotate.\n"
             "This is a partial or ambiguous transition. Check /project demo before taking another lifecycle action."),
            (("lead-session", "coder-session"), False,
             "T-007 is inactive, but neither configured agent session changed.\n"
             "This is a partial or ambiguous transition. Check /project demo before taking another lifecycle action."),
            (("lead-new", "coder-new"), True,
             "T-007 is still active, although both configured agent sessions changed.\n"
             "This is a partial or ambiguous transition. Check /project demo before taking another lifecycle action."),
            (("lead-session", "coder-session"), True,
             "No completed /next transition was observed during the verification window.\n"
             "Check /project demo for the current state."),
        ]
        for sessions, active, wording in cases:
            with self.subTest(sessions=sessions, active=active):
                result = self.run_next(SnapshotTransport(self.root, final_sessions=sessions),
                                       (self.tasks(True), self.tasks(active)))
                self.assertEqual(result, "The /next command was sent to the demo Lead.\n" + wording)

    def test_missing_baseline_task_and_different_active_task_are_safe(self):
        missing = self.run_next(SnapshotTransport(self.root, final_sessions=("lead-new", "coder-new")),
                                (self.tasks(True), []))
        self.assertEqual(missing, "The /next command was sent, but Hermes could not verify the previous task state afterward.\nCheck /project demo for the current status.")
        different = self.run_next(SnapshotTransport(self.root, final_sessions=("lead-new", "coder-new")),
                                  (self.tasks(True), [*self.tasks(False), {"id": "T-008", "active": True, "status": "READY"}]))
        self.assertEqual(different, "The /next command was sent to the demo Lead.\nT-008 is now active; the previous task T-007 is inactive.\nCheck /project demo for the current state before taking another lifecycle action.")

    def test_baseline_requires_exactly_one_active_task_but_not_done_or_handoff_state(self):
        t = SnapshotTransport(self.root)
        records = [{"id": "T-007", "active": True, "status": "READY"}]
        self.run_next(t, (records, records))
        self.assertEqual(sum(isinstance(c, tuple) and c[0] == "send_text" for c in t.calls), 1)
        with self.assertRaisesRegex(bridge.BridgeError, "active task"):
            self.run_next(SnapshotTransport(self.root, online=False), ([],))

    def test_topology_malformed_during_observation_is_safe_and_never_retries(self):
        t = SnapshotTransport(self.root, final_sessions=("lead-new", "coder-new"))
        original = t.snapshot
        calls = [0]
        def malformed():
            value = original(); calls[0] += 1
            if t.dispatched:
                value["agents"][0]["terminal_id"] = "wrong"
            return value
        t.snapshot = malformed
        result = self.run_next(t, (self.tasks(True), self.tasks(False)))
        self.assertEqual(result, "The /next command was sent to the demo Lead.\nThe final runtime snapshot is malformed. Check /project demo for current status.")
        self.assertEqual(sum(isinstance(c, tuple) and c[0] == "send_text" for c in t.calls), 1)
        self.assertEqual(sum(isinstance(c, tuple) and c[0] == "send_keys" for c in t.calls), 1)

    def test_revalidates_exact_lead_before_enter_and_coder_is_observation_only(self):
        replacement = agent(session="replacement", cwd=str(self.root))
        t = SnapshotTransport(self.root, got=[agent(cwd=str(self.root)), replacement])
        with self.assertRaisesRegex(bridge.BridgeError, "identity changed"):
            self.run_next(t, (self.tasks(True),))
        self.assertEqual(sum(isinstance(c, tuple) and c[0] == "send_text" for c in t.calls), 1)
        self.assertEqual(sum(isinstance(c, tuple) and c[0] == "send_keys" for c in t.calls), 0)
        self.assertFalse(any("coder-id" in str(c) and c[0] in {"send_text", "send_keys", "prompt"} for c in t.calls if isinstance(c, tuple)))

    def test_online_and_offline_activation_and_same_alias_lock(self):
        online = SnapshotTransport(self.root); self.run_next(online, (self.tasks(), self.tasks()))
        self.assertFalse(any(isinstance(c, tuple) and c[0] == "run" for c in online.calls))
        offline = SnapshotTransport(self.root, online=False); self.run_next(offline, (self.tasks(), self.tasks()))
        self.assertEqual(sum(isinstance(c, tuple) and c[0] == "run" for c in offline.calls), 1)
        with bridge._IN_FLIGHT_LOCK: bridge._IN_FLIGHT.add("demo")
        try:
            with self.assertRaisesRegex(bridge.BridgeError, "already in flight"):
                self.run_next(SnapshotTransport(self.root), (self.tasks(),))
        finally:
            with bridge._IN_FLIGHT_LOCK: bridge._IN_FLIGHT.discard("demo")


class NextPluginTests(unittest.TestCase):
    def test_registers_next_only_as_command_and_syntax_is_safe(self):
        plugin = importlib.import_module("plugin")
        class C:
            def __init__(self): self.tools=[]; self.commands=[]; self.hooks=[]
            def register_tool(self, name, fn, description, parameters, toolset=""): self.tools.append(name)
            def register_command(self, name, handler, description, usage): self.commands.append((name, handler))
            def register_hook(self, name, handler): self.hooks.append(name)
        c = C(); plugin.register(c)
        self.assertEqual([name for name, _ in c.commands],
                         ["projects", "project", "lead", "execute", "next", "to-task", "to-task-approve"])
        self.assertIn("next", [name for name, _ in c.commands])
        calls=[]; original=plugin._next_project
        try:
            plugin._next_project=lambda alias: calls.append(alias) or "sent"
            for raw in ("", "demo extra"):
                self.assertEqual(asyncio.run(plugin.next_command(raw)), "Usage: /next <project>")
            self.assertEqual(calls, [])
            self.assertEqual(asyncio.run(plugin.next_command("demo")), "sent")
        finally:
            plugin._next_project=original

    def test_unknown_alias_is_owner_safe_and_prose_or_lead_direct_next_cannot_route_raw(self):
        plugin = importlib.import_module("plugin")
        original=plugin._next_project; calls=[]
        try:
            plugin._next_project=lambda alias: calls.append(alias) or (_ for _ in ()).throw(bridge.BridgeError("Unknown project alias 'bad'"))
            self.assertEqual(asyncio.run(plugin.next_command("bad")), "Unknown Sanbi project: bad")
            self.assertEqual(calls, ["bad"])
        finally:
            plugin._next_project=original
        with self.assertRaisesRegex(bridge.BridgeError, "not allowed"):
            bridge._reject_command("/next demo")
        bridge._reject_command("Can we discuss /next demo?")


if __name__ == "__main__":
    unittest.main()
