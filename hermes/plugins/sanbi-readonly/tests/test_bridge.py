from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import re
import sys
import tempfile
import threading
import subprocess
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))

import bridge


def agent(name="lead-id", status="idle", pane="w:p1", label="LEAD", **changes):
    value = {
        "name": name,
        "pane_id": pane,
        "terminal_id": "term-1",
        "workspace_id": "w",
        "pane_label": label,
        "cwd": None,
        "agent_session": {"agent": "pi", "kind": "id", "source": "herdr:pi", "value": "session-1"},
        "interactive_ready": True,
        "agent_status": status,
    }
    value.update(changes)
    return value


class FakeTransport:
    def __init__(self, snapshots=(), listed=None, got=None, ack=None, workspaces=None):
        self.listed = list(listed if listed is not None else [agent()])
        self.got = got if got is not None else agent()
        self.ack = ack if ack is not None else {"type": "agent_prompted", "agent": agent()}
        self.snapshots = list(snapshots)
        self.calls = []
        self.prompt_text = None
        self.workspaces = workspaces

    def list_agents(self):
        self.calls.append("list")
        return self.listed

    def get_agent(self, target):
        self.calls.append(("get", target))
        if isinstance(self.got, list):
            return self.got.pop(0)
        return self.got

    def prompt(self, target, text):
        self.calls.append(("prompt", target))
        self.prompt_text = text
        return self.ack

    def read(self, target, timeout=None):
        self.calls.append(("read", target, timeout))
        if not self.snapshots:
            return ""
        return self.snapshots.pop(0)

    def list_workspaces(self):
        self.calls.append("workspaces")
        if self.workspaces is not None:
            return self.workspaces
        return [{"workspace_id":"w", "active_tab_id":"tab-1", "label":"demo-key", "pane_count":2, "tab_count":1}]

    def snapshot(self):
        self.calls.append("snapshot")
        root = str(getattr(self, "project", ""))
        summaries = self.workspaces if self.workspaces is not None else self.list_workspaces()
        layouts=[]; panes=[]
        for w in summaries:
            wsid=w.get("workspace_id"); tab=w.get("active_tab_id")
            if wsid == "w":
                refs=[{"pane_id":"w:p1"},{"pane_id":"w:p2"}]
                panes += [{"pane_id":"w:p1","label":"LEAD","terminal_id":"term-1","cwd":root},
                          {"pane_id":"w:p2","label":"CODER","terminal_id":"term-2","cwd":root}]
            else: refs=[]
            layouts.append({"workspace_id":wsid,"tab_id":tab,"panes":refs})
        return {"workspaces":summaries,"layouts":layouts,"panes":panes,"agents":self.listed}


class Clock:
    def __init__(self): self.value = 0.0
    def monotonic(self): return self.value
    def sleep(self, seconds): self.value += seconds


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp_obj = tempfile.TemporaryDirectory()
        self.tmp = Path(self.tmp_obj.name)
        self.project = self.tmp / "project"
        (self.project / ".agent").mkdir(parents=True)
        (self.project / ".agent/config.json").write_text(json.dumps({"project":{"key":"demo-key"}, "herdr": {"leadAgent": "lead-id", "coderAgent":"coder-id"}}), encoding="utf-8")
        self.registry = self.tmp / "projects.json"
        self.registry.write_text(json.dumps({"projects": {"demo": {"path": str(self.project)}}}), encoding="utf-8")

    def tearDown(self):
        self.tmp_obj.cleanup()
        bridge._IN_FLIGHT.clear()

    def ask(self, transport, message="hello", **kwargs):
        transport.project = self.project
        for item in transport.listed:
            if item.get("name") in {"lead-id", "coder-id"}: item["cwd"] = str(self.project)
        if (any(item.get("name") == "lead-id" for item in transport.listed) and
                not any(item.get("name") == "coder-id" for item in transport.listed)):
            transport.listed.append(agent("coder-id", pane="w:p2", label="CODER", terminal_id="term-2", cwd=str(self.project)))
        if isinstance(transport.got, dict) and transport.got.get("name") == "lead-id": transport.got["cwd"] = str(self.project)
        clock = kwargs.pop("clock", Clock())
        return bridge.ask_lead("demo", message, registry_path=self.registry, transport=transport,
                               monotonic=clock.monotonic, sleep=clock.sleep,
                               timeout=kwargs.pop("timeout", 2.0), interval=kwargs.pop("interval", 0.5), **kwargs)

    def test_online_second_request_reuses_live_session(self):
        token = "AbCdEf123_-x"
        for answer in ("one", "two"):
            t = FakeTransport(["", f"<<H:{token}>>{answer}<</H:{token}>>"])
            self.assertEqual(self.ask(t, token_factory=lambda: token), answer)
            self.assertIn(("get", "w:p1"), t.calls)

    def test_dynamic_initialized_alias_uses_canonical_resolver_case_insensitively(self):
        workspace = self.tmp / "Workspace"; project = workspace / "Dynamic"; (project / ".agent").mkdir(parents=True)
        (project / ".agent/config.json").write_text(json.dumps({
            "project": {"key": "dynamic-key"},
            "herdr": {"leadAgent": "dynamic-lead", "coderAgent": "dynamic-coder"},
        }), encoding="utf-8")
        registry = self.tmp / "dynamic-projects.json"
        registry.write_text(json.dumps({"workspace_roots": [str(workspace)], "projects": {}}), encoding="utf-8")
        self.assertEqual(bridge._resolve("DYNAMIC", registry),
                         (project.resolve(), "dynamic-key", "dynamic-lead", "dynamic-coder"))

    def test_dynamic_uninitialized_lead_activates_normal_sanbi_once_then_resolves_identity(self):
        workspace = self.tmp / "Workspace"; project = workspace / "newgame"; project.mkdir(parents=True)
        registry = self.tmp / "dynamic-projects.json"
        registry.write_text(json.dumps({"workspace_roots": [str(workspace)], "projects": {}}), encoding="utf-8")
        token = "AbCdEf123_-x"
        transport = FakeTransport(["", f"<<H:{token}>>done<</H:{token}>>"])
        expected = bridge._identity(agent())
        original_activate, original_runtime = bridge._activate, bridge._runtime
        activations = []
        try:
            def activate(_transport, root, *_args):
                activations.append(root)
                (root / ".agent").mkdir()
                (root / ".agent/config.json").write_text(json.dumps({
                    "project": {"key": "demo-key"},
                    "herdr": {"leadAgent": "lead-id", "coderAgent": "coder-id"},
                }), encoding="utf-8")
            bridge._activate = activate
            bridge._runtime = lambda *_args: (expected, True)
            clock = Clock()
            answer = bridge.ask_lead("NEWGAME", "inspect", registry_path=registry,
                                     transport=transport, token_factory=lambda: token,
                                     monotonic=clock.monotonic, sleep=clock.sleep)
            self.assertEqual(answer, "done")
            self.assertEqual(activations, [project.resolve()])
        finally:
            bridge._activate, bridge._runtime = original_activate, original_runtime

    def test_forbidden_command_rejects_before_transport(self):
        t = FakeTransport([], listed=[])
        with self.assertRaisesRegex(bridge.BridgeError, "workflow command"):
            self.ask(t, "/execute")
        self.assertEqual(t.calls, [])

    def test_token_is_unique_twelve_urlsafe_characters(self):
        values = {bridge.new_token() for _ in range(200)}
        self.assertEqual(len(values), 200)
        self.assertTrue(all(re.fullmatch(r"[A-Za-z0-9_-]{12}", value) for value in values))

    def test_overlap_accumulator_growth_sliding_and_repeats(self):
        self.assertEqual(bridge.accumulate("A", "AB"), "AB")
        self.assertEqual(bridge.accumulate("AB", "ABC"), "ABC")
        value = bridge.accumulate("abc123", "123def")
        self.assertEqual(value, "abc123def")
        self.assertEqual(bridge.accumulate(value, "def456"), "abc123def456")
        self.assertEqual(bridge.accumulate("old dropped", "new window"), "old dropped\nnew window")
        self.assertEqual(bridge.accumulate("same", "same"), "same")

    def test_marker_split_across_snapshots_succeeds_without_duplication(self):
        token = "AbCdEf123_-x"
        t = FakeTransport(["baseline", f"noise <<H:{token}", f"<<H:{token}>>answer", f">>answer<</H:{token}>>"])
        self.assertEqual(self.ask(t, token_factory=lambda: token), "answer")

    def test_growing_terminal_snapshot_repeating_open_marker_is_not_ambiguous(self):
        token = "AbCdEf123_-x"
        prompt_echo = "transport prompt and tool activity"
        partial = f"{prompt_echo}\n<<H:{token}>>\npartial"
        complete = f"{prompt_echo}\n<<H:{token}>>\ncomplete answer\n<</H:{token}>>"
        t = FakeTransport(["baseline", partial, complete])
        self.assertEqual(self.ask(t, token_factory=lambda: token), "complete answer")

    def test_repeated_partial_views_do_not_fail_before_complete_current_snapshot(self):
        token = "AbCdEf123_-x"
        first = f"view one\n<<H:{token}>>\npartial"
        second = f"changed viewport\n<<H:{token}>>\npartial grows"
        complete = f"latest viewport\n<<H:{token}>>\nfinal\n<</H:{token}>>"
        t = FakeTransport(["baseline", first, second, complete])
        self.assertEqual(self.ask(t, token_factory=lambda: token), "final")

    def test_echoed_wrapper_cannot_parse_as_answer_and_contains_no_literal_marker(self):
        token = "AbCdEf123_-x"
        wrapped = bridge.wrap_message("hello", token)
        self.assertNotIn(f"<<H:{token}>>", wrapped)
        self.assertNotIn(f"<</H:{token}>>", wrapped)
        self.assertIsNone(bridge._parse_markers(wrapped, token))
        t = FakeTransport([wrapped, wrapped, f"{wrapped}\n<<H:{token}>>real<</H:{token}>>"])
        self.assertEqual(self.ask(t, token_factory=lambda: token), "real")

    def test_current_marker_collision_in_baseline_fails_before_delivery(self):
        token = "AbCdEf123_-x"
        t = FakeTransport([f"old <<H:{token}>>stale<</H:{token}>>"])
        with self.assertRaisesRegex(bridge.BridgeError, "collid"):
            self.ask(t, token_factory=lambda: token)
        self.assertFalse(any(call[0] == "prompt" for call in t.calls if isinstance(call, tuple)))

    def test_wrong_and_stale_tokens_are_ignored(self):
        token = "AbCdEf123_-x"
        t = FakeTransport(["<<H:OLDTOKEN1234>>stale<</H:OLDTOKEN1234>>", f"x<<H:{token}>> current <</H:{token}>>"])
        self.assertEqual(self.ask(t, token_factory=lambda: token), "current")

    def test_multiple_or_closing_only_markers_fail_closed(self):
        token = "AbCdEf123_-x"
        pair = f"<<H:{token}>>a<</H:{token}>>"
        with self.assertRaisesRegex(bridge.BridgeError, "ambiguous"):
            self.ask(FakeTransport(["", pair + pair]), token_factory=lambda: token)
        with self.assertRaisesRegex(bridge.BridgeError, "ambiguous"):
            self.ask(FakeTransport(["", f"<</H:{token}>>"]), token_factory=lambda: token)

    def test_empty_answer_fails(self):
        token = "AbCdEf123_-x"
        with self.assertRaisesRegex(bridge.BridgeError, "empty"):
            self.ask(FakeTransport(["", f"<<H:{token}>>  <</H:{token}>>"]), token_factory=lambda: token)

    def test_zero_or_open_only_deadline_has_same_safe_timeout_and_no_partial(self):
        token = "AbCdEf123_-x"
        for snapshots in (["", "nothing"], ["", f"<<H:{token}>>partial"]):
            with self.assertRaisesRegex(bridge.BridgeError, re.escape(bridge.SAFE_TIMEOUT)) as caught:
                self.ask(FakeTransport(snapshots), token_factory=lambda: token, timeout=0.5)
            self.assertNotIn("partial", str(caught.exception))

    def test_lifecycle_idle_without_close_continues_to_deadline(self):
        token = "AbCdEf123_-x"
        t = FakeTransport(["", f"<<H:{token}>>partial", f"<<H:{token}>>partial"])
        with self.assertRaisesRegex(bridge.BridgeError, re.escape(bridge.SAFE_TIMEOUT)):
            self.ask(t, token_factory=lambda: token, timeout=1.0)
        self.assertGreaterEqual(sum(call[0] == "read" for call in t.calls if isinstance(call, tuple)), 2)

    def test_default_response_timeout_is_ten_minutes(self):
        self.assertEqual(bridge.LEAD_RESPONSE_TIMEOUT_SECONDS, 600.0)
        self.assertEqual(inspect.signature(bridge.ask_lead).parameters["timeout"].default, 600.0)

    def test_late_current_token_sentinel_at_150_seconds_succeeds_without_reprompt(self):
        token = "AbCdEf123_-x"
        clock = Clock()
        t = FakeTransport(["", "working", f"<<H:{token}>>late<</H:{token}>>"])
        self.assertEqual(self.ask(t, token_factory=lambda: token, timeout=600.0,
                                  interval=150.0, clock=clock), "late")
        self.assertGreaterEqual(clock.value, 150.0)
        self.assertEqual(sum(call[0] == "prompt" for call in t.calls if isinstance(call, tuple)), 1)

    def test_late_current_token_sentinel_at_300_seconds_succeeds(self):
        token = "AbCdEf123_-x"
        clock = Clock()
        t = FakeTransport(["", "working", f"<<H:{token}>>later<</H:{token}>>"])
        self.assertEqual(self.ask(t, token_factory=lambda: token, timeout=600.0,
                                  interval=300.0, clock=clock), "later")
        self.assertGreaterEqual(clock.value, 300.0)

    def test_ten_minute_timeout_is_bounded_and_does_not_reprompt(self):
        token = "AbCdEf123_-x"
        clock = Clock()
        t = FakeTransport(["", "working", "still working"])
        with self.assertRaisesRegex(bridge.BridgeError, "10 minutes") as caught:
            self.ask(t, token_factory=lambda: token, timeout=600.0, interval=300.0, clock=clock)
        self.assertEqual(clock.value, 600.0)
        self.assertEqual(sum(call[0] == "prompt" for call in t.calls if isinstance(call, tuple)), 1)
        self.assertNotRegex(str(caught.exception), r"READY|PLANNED|failed")

    def test_response_clock_starts_after_prompt_acknowledgment(self):
        token = "AbCdEf123_-x"
        clock = Clock()
        class DelayedPromptTransport(FakeTransport):
            def prompt(inner_self, target, text):
                clock.value += 50.0
                return super().prompt(target, text)
        t = DelayedPromptTransport(["", f"<<H:{token}>>ok<</H:{token}>>"])
        self.assertEqual(self.ask(t, token_factory=lambda: token, timeout=600.0, clock=clock), "ok")
        read_timeouts = [call[2] for call in t.calls if isinstance(call, tuple) and call[0] == "read"]
        self.assertGreater(read_timeouts[-1], 599.0)

    def test_unchanged_revision_with_pair_succeeds_and_stops_polling(self):
        token = "AbCdEf123_-x"
        a = agent(revision=7)
        t = FakeTransport(["baseline", f"<<H:{token}>>ok<</H:{token}>>", "must-not-read"], listed=[a], got=a,
                          ack={"type": "agent_prompted", "agent": a})
        self.assertEqual(self.ask(t, token_factory=lambda: token), "ok")
        self.assertEqual(len(t.snapshots), 1)

    def test_native_skipped_screen_detection_is_accepted_but_other_sources_fail_closed(self):
        token = "AbCdEf123_-x"
        native = agent(screen_detection_skipped=True, revision=7)
        t = FakeTransport(["baseline", f"<<H:{token}>>ok<</H:{token}>>"], listed=[native], got=[native, native],
                          ack={"type": "agent_prompted", "agent": native})
        self.assertEqual(self.ask(t, token_factory=lambda: token), "ok")
        unsafe = agent(screen_detection_skipped=True, agent_session={"agent":"pi", "kind":"id", "source":"other", "value":"session-1"})
        with self.assertRaisesRegex(bridge.BridgeError, "source"):
            self.ask(FakeTransport([], listed=[unsafe], got=unsafe))

    def test_identity_is_revalidated_after_complete_pair(self):
        token = "AbCdEf123_-x"
        before = agent()
        replacement = agent(agent_session={"agent":"pi", "kind":"id", "source":"herdr:pi", "value":"replacement"})
        t = FakeTransport(["baseline", f"<<H:{token}>>answer<</H:{token}>>"], got=[before, replacement])
        with self.assertRaisesRegex(bridge.BridgeError, "identity changed"):
            self.ask(t, token_factory=lambda: token)

    def test_no_poll_before_valid_ack_and_no_retry(self):
        t = FakeTransport(["should-not-read"], ack={"type": "wrong", "agent": agent()})
        with self.assertRaisesRegex(bridge.BridgeError, "acknowledgment"):
            self.ask(t)
        self.assertEqual(sum(isinstance(call, tuple) and call[0] == "read" for call in t.calls), 1)
        self.assertEqual(sum(isinstance(call, tuple) and call[0] == "prompt" for call in t.calls), 1)

    def test_preflight_identity_and_safe_state_are_strict(self):
        cases = [
            ([agent(), agent()], agent(), "More than one"),
            ([agent()], agent(pane_id="other"), "identity"),
            ([agent(interactive_ready=False)], agent(interactive_ready=False), "interactive"),
            ([agent(launch_pending=True)], agent(launch_pending=True), "launch"),
            ([agent(status="working")], agent(status="working"), "busy"),
            ([agent(status="blocked")], agent(status="blocked"), "unsafe"),
            ([agent(status="unknown")], agent(status="unknown"), "unsafe"),
        ]
        for listed, got, needle in cases:
            with self.subTest(needle=needle), self.assertRaisesRegex(bridge.BridgeError, needle):
                self.ask(FakeTransport([], listed=listed, got=got))

    def test_absent_busy_and_delivered_timeout_messages_are_owner_actionable(self):
        with self.assertRaisesRegex((bridge.BridgeError, AttributeError), r"create_workspace|bootstrap"):
            self.ask(FakeTransport([], listed=[], workspaces=[]))
        with self.assertRaisesRegex(bridge.BridgeError,
                                    r"demo Lead is currently busy\. Try again after the current Lead turn finishes\."):
            busy = agent(status="working")
            self.ask(FakeTransport([], listed=[busy], got=busy))
        with self.assertRaisesRegex(bridge.BridgeError,
                                    r"delivered to the demo Lead.*complete response within 10 minutes.*not retried or cancelled"):
            self.ask(FakeTransport(["", "unmarked"]), timeout=.5)

    def test_launch_pending_omitted_false_and_done_are_accepted(self):
        token = "AbCdEf123_-x"
        a = agent(status="done")
        t = FakeTransport(["", f"<<H:{token}>>ok<</H:{token}>>"], listed=[a], got=a,
                          ack={"type": "agent_prompted", "agent": a})
        self.assertEqual(self.ask(t, token_factory=lambda: token), "ok")

    def test_wrapper_preserves_owner_message_and_uses_one_pair_instruction(self):
        token = "AbCdEf123_-x"
        message = "literal ; & | $(x)\nsecond line"
        t = FakeTransport(["", f"<<H:{token}>>ok<</H:{token}>>"])
        self.ask(t, message, token_factory=lambda: token)
        self.assertEqual(t.prompt_text, bridge.wrap_message(message, token))
        self.assertEqual(t.prompt_text.count(message), 1)
        self.assertIn("exactly one pair around your final answer only", t.prompt_text)
        self.assertIn("concatenate", t.prompt_text)

    def test_wrapper_makes_remote_turn_noninteractive(self):
        wrapped = bridge.wrap_message("owner text", "AbCdEf123_-x")
        self.assertIn("remote owner turn delivered through Hermes/Telegram", wrapped)
        self.assertIn("Do not invoke ask_user", wrapped)
        self.assertIn("do not wait for terminal input", wrapped)
        self.assertIn("final owner-facing response", wrapped)
        self.assertIn("inside the Hermes response markers", wrapped)
        self.assertIn("stop the turn normally", wrapped)
        self.assertIn("later Telegram message", wrapped)

    def test_wrapper_preserves_existing_owner_authorization(self):
        message = "use /to-task to turn W3 into a ready task"
        wrapped = bridge.wrap_message(message, "AbCdEf123_-x")
        self.assertEqual(wrapped.count(message), 1)
        self.assertIn("already explicitly authorizes", wrapped)
        self.assertIn("do not ask for duplicate confirmation", wrapped)


    def test_leading_workflow_commands_blocked_but_prose_mentions_allowed(self):
        blocked = ["/execute", "/next now", "/to-task x", "/to-spec", "/to-tickets x", "/task-reset x", "/subagents on"]
        for text in blocked:
            with self.subTest(text=text), self.assertRaisesRegex(bridge.BridgeError, "workflow command"):
                self.ask(FakeTransport([]), text)
        token = "AbCdEf123_-x"
        t = FakeTransport(["", f"<<H:{token}>>ok<</H:{token}>>"])
        self.assertEqual(self.ask(t, "Explain /execute without running it", token_factory=lambda: token), "ok")

    def test_conversation_bridge_has_no_lifecycle_escape_hatch(self):
        for payload in ("/to-task W4", "/execute", "/next"):
            with self.subTest(payload=payload):
                t = FakeTransport([])
                with self.assertRaisesRegex(bridge.BridgeError, "workflow command"):
                    self.ask(t, payload)
                self.assertEqual(sum(call[0] == "prompt" for call in t.calls if isinstance(call, tuple)), 0)

    def test_lock_released_on_success_preflight_ack_timeout_and_parse_failure(self):
        token = "AbCdEf123_-x"
        transports = [
            FakeTransport(["", f"<<H:{token}>>ok<</H:{token}>>"]),
            FakeTransport([], listed=[]),
            FakeTransport([], ack={"type": "wrong", "agent": agent()}),
            FakeTransport(["", "nothing"]),
            FakeTransport(["", f"<</H:{token}>>"]),
        ]
        for t in transports:
            try: self.ask(t, token_factory=lambda: token, timeout=0.5)
            except bridge.BridgeError: pass
            self.assertNotIn("demo", bridge._IN_FLIGHT)

    def test_process_local_per_alias_lock_rejects_concurrent_request(self):
        bridge._IN_FLIGHT.add("demo")
        with self.assertRaisesRegex(bridge.BridgeError, "already in flight"):
            self.ask(FakeTransport([]))

    def test_process_local_lock_check_and_add_are_thread_safe(self):
        entered = threading.Event()
        release = threading.Event()
        class BlockingTransport(FakeTransport):
            def prompt(self, target, text):
                result = super().prompt(target, text)
                entered.set(); release.wait(2)
                return result
        token = "AbCdEf123_-x"
        first = BlockingTransport(["baseline", f"<<H:{token}>>ok<</H:{token}>>"])
        outcomes = []
        thread = threading.Thread(target=lambda: outcomes.append(self.ask(first, token_factory=lambda: token)))
        thread.start(); self.assertTrue(entered.wait(1))
        with self.assertRaisesRegex(bridge.BridgeError, "already in flight"):
            self.ask(FakeTransport([]))
        release.set(); thread.join(2)
        self.assertEqual(outcomes, ["ok"])

    def test_alias_config_and_project_remain_immutable(self):
        before = [(str(p.relative_to(self.project)), p.stat().st_size, p.stat().st_mtime_ns,
                   hashlib.sha256(p.read_bytes()).hexdigest()) for p in self.project.rglob("*") if p.is_file()]
        token = "AbCdEf123_-x"
        self.assertEqual(self.ask(FakeTransport(["", f"<<H:{token}>>ok<</H:{token}>>"]), token_factory=lambda: token), "ok")
        after = [(str(p.relative_to(self.project)), p.stat().st_size, p.stat().st_mtime_ns,
                  hashlib.sha256(p.read_bytes()).hexdigest()) for p in self.project.rglob("*") if p.is_file()]
        self.assertEqual(before, after)

    def test_invalid_timeout_and_interval_fail_before_delivery(self):
        for timeout, interval in [(0, .5), (-1, .5), (float("inf"), .5), (1, 0), (1, float("nan"))]:
            t = FakeTransport([])
            with self.subTest(timeout=timeout, interval=interval), self.assertRaisesRegex(bridge.BridgeError, "finite positive"):
                self.ask(t, timeout=timeout, interval=interval)
            self.assertFalse(any(call[0] == "prompt" for call in t.calls if isinstance(call, tuple)))

    def test_each_read_is_bounded_by_remaining_deadline(self):
        token = "AbCdEf123_-x"
        t = FakeTransport(["baseline", "still waiting"])
        with self.assertRaisesRegex(bridge.BridgeError, re.escape(bridge.SAFE_TIMEOUT)):
            self.ask(t, token_factory=lambda: token, timeout=.25, interval=.25)
        read_timeouts = [call[2] for call in t.calls if isinstance(call, tuple) and call[0] == "read"]
        self.assertTrue(all(value is not None and 0 < value <= .25 for value in read_timeouts[1:]))


class LazyActivationTests(unittest.TestCase):
    def setUp(self):
        self.tmp_obj=tempfile.TemporaryDirectory(); self.root=Path(self.tmp_obj.name)/"Project O'Brien & (demo)"
        (self.root/".agent").mkdir(parents=True)
        (self.root/".agent/config.json").write_text(json.dumps({"project":{"key":"project-key"},"herdr":{"leadAgent":"lead-id","coderAgent":"coder-id"}}),encoding="utf-8")
        self.registry=Path(self.tmp_obj.name)/"projects.json"; self.registry.write_text(json.dumps({"projects":{"demo":{"path":str(self.root)}}}),encoding="utf-8")
    def tearDown(self): self.tmp_obj.cleanup(); bridge._IN_FLIGHT.clear()

    def test_offline_exact_shell_activation_then_one_prompt(self):
        token="AbCdEf123_-x"; root=self.root
        class T(FakeTransport):
            def __init__(self): super().__init__(listed=[],workspaces=[]); self.phase=0; self.commands=[]; self.pane_reads=["PS>","__HS_OK_ActToken123"]
            def create_workspace(self,cwd,label):
                self.calls.append(("create",cwd,label)); self.phase=1
                return {"type":"workspace_created","workspace":{},"tab":{},"root_pane":{}}
            def list_workspaces(self):
                self.calls.append("workspaces"); boot={"workspace_id":"boot","active_tab_id":"btab","label":"hermes-sanbi-bootstrap","pane_count":1,"tab_count":1}
                if self.phase==0:return []
                if self.phase==1:return [boot]
                return [boot,{"workspace_id":"proj","active_tab_id":"ptab","label":"project-key","pane_count":2,"tab_count":1}]
            def snapshot(self):
                summaries=self.list_workspaces(); layouts=[]; panes=[]
                for w in summaries:
                    if w["workspace_id"]=="boot": refs=[{"pane_id":"boot:p1"}]; panes.append({"pane_id":"boot:p1","terminal_id":"bt","cwd":str(root),"label":"shell"})
                    else:
                        refs=[{"pane_id":"proj:l"},{"pane_id":"proj:c"}]
                        panes += [{"pane_id":"proj:l","label":"LEAD","terminal_id":"lt","cwd":str(root)},{"pane_id":"proj:c","label":"CODER","terminal_id":"ct","cwd":str(root)}]
                    layouts.append({"workspace_id":w["workspace_id"],"tab_id":w["active_tab_id"],"panes":refs})
                return {"workspaces":summaries,"layouts":layouts,"panes":panes,"agents":self.list_agents()}
            def pane_process_info(self,pane): return {"pane_id":pane,"shell_pid":10,"foreground_process_group_id":10,"foreground_processes":[{"pid":10,"name":"powershell.exe","argv0":"powershell.exe","argv":[],"cmdline":"powershell.exe","cwd":str(root)}]}
            def run_pane(self,pane,command): self.commands.append((pane,command)); self.phase=2
            def read_pane(self,pane,timeout=None): return self.pane_reads.pop(0) if self.pane_reads else ""
            def list_agents(self):
                self.calls.append("list")
                if self.phase<2:return []
                return [agent("lead-id",pane="proj:l",terminal_id="lt",workspace_id="proj",cwd=str(root)),agent("coder-id",pane="proj:c",label="CODER",terminal_id="ct",workspace_id="proj",cwd=str(root))]
            def get_agent(self,target): self.calls.append(("get",target)); return next(a for a in self.list_agents() if a["pane_id"]==target)
            def prompt(self,target,text): self.calls.append(("prompt",target)); self.prompt_text=text; return {"type":"agent_prompted","agent":self.get_agent(target)}
            def read(self,target,timeout=None): self.calls.append(("read",target,timeout)); return "" if len([c for c in self.calls if isinstance(c,tuple) and c[0]=="read"])==1 else f"<<H:{token}>>answer<</H:{token}>>"
        t=T(); clock=Clock()
        self.assertEqual(bridge.ask_lead("demo","owner & message",registry_path=self.registry,transport=t,timeout=5,interval=.1,monotonic=clock.monotonic,sleep=clock.sleep,token_factory=lambda:token,activation_token_factory=lambda:"ActToken123"),"answer")
        self.assertEqual(len(t.commands),1); command=t.commands[0][1]
        self.assertIn("Set-Location -LiteralPath '"+str(root).replace("'","''")+"'; $global:LASTEXITCODE = $null; sanbi;",command)
        self.assertNotIn("__HS_OK_ActToken123",command); self.assertNotIn("__HS_FAIL_ActToken123",command)
        self.assertIn("$global:LASTEXITCODE = $null",command); self.assertIn("$code=$LASTEXITCODE",command); self.assertNotIn("owner & message",command)
        self.assertEqual(sum(isinstance(c,tuple) and c[0]=="prompt" for c in t.calls),1)

    def test_transient_agent_read_timeout_is_polled_until_outer_deadline(self):
        token="AbCdEf123_-x"
        class T(FakeTransport):
            def __init__(self):
                super().__init__(listed=[agent("lead-id"), agent("coder-id", pane="w:p2", label="CODER", terminal_id="term-2")])
                self.read_count=0
            def read(self,target,timeout=None):
                self.read_count += 1
                if self.read_count == 1: return ""
                if self.read_count == 2: raise bridge.HerdrTimeout("Herdr read timed out")
                return f"<<H:{token}>>answer<</H:{token}>>"
        t=T(); clock=Clock(); t.project=self.root
        for item in t.listed: item["cwd"] = str(self.root)
        t.got = t.listed[0]
        t.ack = {"type":"agent_prompted", "agent":t.listed[0]}
        t.workspaces = [{"workspace_id":"w", "active_tab_id":"tab-1", "label":"project-key", "pane_count":2, "tab_count":1}]
        self.assertEqual(bridge.ask_lead("demo", "hello", registry_path=self.registry, transport=t,
                         timeout=2, interval=.1, monotonic=clock.monotonic, sleep=clock.sleep,
                         token_factory=lambda:token), "answer")
        self.assertEqual(t.read_count, 3)

    def test_transient_read_timeout_after_old_boundary_still_allows_success(self):
        token = "AbCdEf123_-x"; clock = Clock()
        class T(FakeTransport):
            def __init__(inner_self):
                super().__init__([""], listed=[agent("lead-id"), agent("coder-id", pane="w:p2", label="CODER", terminal_id="term-2")])
                inner_self.read_count = 0
            def read(inner_self, target, timeout=None):
                inner_self.read_count += 1
                if inner_self.read_count == 1: return ""
                if inner_self.read_count == 2:
                    clock.value = 170.0
                    raise bridge.HerdrTimeout("typed transient")
                clock.value = 200.0
                return f"<<H:{token}>>answer<</H:{token}>>"
        t = T(); t.project = self.root
        for item in t.listed: item["cwd"] = str(self.root)
        t.got = t.listed[0]
        t.ack = {"type":"agent_prompted", "agent":t.listed[0]}
        t.workspaces = [{"workspace_id":"w", "active_tab_id":"tab-1", "label":"project-key", "pane_count":2, "tab_count":1}]
        self.assertEqual(bridge.ask_lead("demo", "hello", registry_path=self.registry, transport=t,
                         token_factory=lambda:token, timeout=600.0, interval=.5,
                         monotonic=clock.monotonic, sleep=clock.sleep), "answer")
        self.assertEqual(t.read_count, 3)

    def test_nonretryable_read_failure_after_old_boundary_is_immediate(self):
        clock = Clock()
        class T(FakeTransport):
            def __init__(inner_self):
                super().__init__([""], listed=[agent("lead-id"), agent("coder-id", pane="w:p2", label="CODER", terminal_id="term-2")])
                inner_self.read_count = 0
            def read(inner_self, target, timeout=None):
                inner_self.read_count += 1
                if inner_self.read_count == 1: return ""
                clock.value = 170.0
                raise bridge.BridgeError("Herdr read failed")
        t = T(); t.project = self.root
        for item in t.listed: item["cwd"] = str(self.root)
        t.got = t.listed[0]
        t.ack = {"type":"agent_prompted", "agent":t.listed[0]}
        t.workspaces = [{"workspace_id":"w", "active_tab_id":"tab-1", "label":"project-key", "pane_count":2, "tab_count":1}]
        with self.assertRaisesRegex(bridge.BridgeError, "Herdr read failed"):
            bridge.ask_lead("demo", "hello", registry_path=self.registry, transport=t,
                            timeout=600.0, interval=.5, monotonic=clock.monotonic, sleep=clock.sleep)
        self.assertEqual(t.read_count, 2)
        self.assertEqual(clock.value, 170.0)

    def test_partial_runtime_fails_without_activation(self):
        t=FakeTransport([],listed=[],workspaces=[{"workspace_id":"p","active_tab_id":"t","label":"project-key","pane_count":0,"tab_count":1}])
        with self.assertRaisesRegex(bridge.BridgeError,"malformed"): bridge.ask_lead("demo","hello",registry_path=self.registry,transport=t)
        self.assertFalse(any(isinstance(c,tuple) and c[0] in {"create","run"} for c in t.calls))


class CliTransportTests(unittest.TestCase):
    def test_snapshot_create_and_process_info_use_real_091_envelopes(self):
        calls=[]
        responses=[
            {"type":"session_snapshot","snapshot":{"workspaces":[],"layouts":[],"panes":[],"agents":[]}},
            {"type":"workspace_created","workspace":{"workspace_id":"w"},"tab":{"tab_id":"t"},"root_pane":{"pane_id":"p"}},
            {"type":"pane_process_info","process_info":{"pane_id":"p","shell_pid":7,"foreground_process_group_id":7,"foreground_processes":[]}},
        ]
        class Done:
            stderr=""; returncode=0
            def __init__(self,value): self.stdout=json.dumps({"id":"x","result":value})
        def run(argv,**kwargs): calls.append((argv,kwargs)); return Done(responses.pop(0))
        t=bridge.HerdrTransport(run=run)
        self.assertEqual(t.snapshot()["agents"],[])
        self.assertEqual(t.create_workspace("C:/trusted","exact")["type"],"workspace_created")
        self.assertEqual(t.pane_process_info("p")["shell_pid"],7)
        self.assertEqual(calls[0][0][1:],["api","snapshot"])
        self.assertEqual(calls[1][0][1:],["workspace","create","--cwd","C:/trusted","--label","exact","--no-focus"])
        self.assertEqual(calls[1][1]["timeout"],10.0)
        self.assertEqual(calls[2][0][1:],["pane","process-info","--pane","p"])

    def test_pane_run_uses_unstructured_091_contract(self):
        calls=[]
        class Done:
            stderr=""; returncode=0; stdout=""
        def run(*args, **kwargs):
            calls.append((args, kwargs)); return Done()
        t=bridge.HerdrTransport(run=run)
        self.assertEqual(t.run_pane("w:p1", "Write-Output 'ok'"), "")
        self.assertEqual(calls[0][0][0][1:], ["pane", "run", "w:p1", "Write-Output 'ok'"])

    def test_real_091_envelopes_fail_closed_when_malformed(self):
        class Done:
            stderr=""; returncode=0; stdout=json.dumps({"id":"x","result":{"type":"wrong"}})
        for action in (lambda t:t.snapshot(),lambda t:t.create_workspace("C:/x","x"),lambda t:t.pane_process_info("p")):
            with self.subTest(action=action), self.assertRaises(bridge.BridgeError):
                action(bridge.HerdrTransport(run=lambda *a,**k:Done()))

    def test_argv_shell_false_separate_streams_and_fixed_091_binary(self):
        calls = []
        class Done:
            stdout = '{"id":"x","result":{"agents":[],"type":"agent_list"}}'
            stderr = ""
            returncode = 0
        def run(argv, **kwargs):
            calls.append((argv, kwargs)); return Done()
        transport = bridge.HerdrTransport(run=run)
        self.assertEqual(transport.list_agents(), [])
        argv, kwargs = calls[0]
        self.assertRegex(argv[0].replace("\\", "/"), r"/releases/0\.9\.1-x86_64-pc-windows-msvc/herdr\.exe$")
        self.assertEqual(argv[1:], ["agent", "list"])
        self.assertFalse(kwargs["shell"])
        self.assertTrue(kwargs["capture_output"])
        self.assertGreater(kwargs["timeout"], 0)

    def test_read_uses_only_supported_agent_recent_unwrapped_text(self):
        calls = []
        class Done: stdout="text"; stderr=""; returncode=0
        def run(argv, **kwargs): calls.append(argv); return Done()
        value = bridge.HerdrTransport(run=run).read("w:p1")
        self.assertEqual(value, "text")
        self.assertEqual(calls[0][1:], ["agent", "read", "w:p1", "--source", "recent-unwrapped", "--format", "text"])

    def test_shell_metacharacters_remain_single_prompt_argument(self):
        calls = []
        payload = "hello & whoami | calc $(bad)"
        info = agent()
        class Done:
            stderr=""; returncode=0
            stdout=json.dumps({"id":"x","result":{"type":"agent_prompted","agent":info}})
        def run(argv, **kwargs): calls.append((argv, kwargs)); return Done()
        bridge.HerdrTransport(run=run).prompt("w:p1", payload)
        self.assertEqual(calls[0][0][1:], ["agent", "prompt", "w:p1", payload])
        self.assertFalse(calls[0][1]["shell"])

    def test_transport_errors_never_expose_stderr_and_timeout_is_safe(self):
        secret = "credential=TOPSECRET owner message"
        class Failed: stdout=""; stderr=secret; returncode=1
        with self.assertRaises(bridge.BridgeError) as caught:
            bridge.HerdrTransport(run=lambda *a, **k: Failed()).read("w:p1")
        self.assertNotIn(secret, str(caught.exception))
        def timed_out(*args, **kwargs): raise subprocess.TimeoutExpired(args[0], kwargs["timeout"], stderr=secret)
        with self.assertRaisesRegex(bridge.BridgeError, "read timed out") as caught:
            bridge.HerdrTransport(run=timed_out).read("w:p1", timeout=.1)
        self.assertNotIn(secret, str(caught.exception))


if __name__ == "__main__":
    unittest.main()
