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


def agent(name="lead-id", status="idle", pane="w:l", label="LEAD", session="lead-session", **changes):
    value = {
        "name": name, "pane_id": pane, "terminal_id": "lt" if label == "LEAD" else "ct",
        "workspace_id": "w", "pane_label": label, "cwd": None,
        "agent_session": {"agent": "pi", "kind": "id", "source": "herdr:pi", "value": session},
        "interactive_ready": True, "agent_status": status,
    }
    value.update(changes)
    return value


class Clock:
    def __init__(self): self.value = 0.0
    def monotonic(self): return self.value
    def sleep(self, seconds): self.value += seconds


class ExecuteTransport:
    def __init__(self, root: Path, *, online=True, states=("READY",), lead_status="idle", got=None,
                 snapshot_mutator=None):
        self.root=root; self.online=online; self.phase="project" if online else "absent"; self.calls=[]
        self.states=list(states); self.state_index=0; self.commands=[]; self.pane_reads=["PS>", "__HS_OK_ActToken123"]
        self.lead=agent(status=lead_status, cwd=str(root))
        self.coder=agent("coder-id", pane="w:c", label="CODER", terminal_id="ct", session="coder-session", cwd=str(root), status="working")
        self.got=list(got) if got is not None else None
        self.snapshot_mutator=snapshot_mutator
    def list_workspaces(self):
        self.calls.append("workspaces")
        if self.phase == "absent": return []
        if self.phase == "boot":
            return [{"workspace_id":"boot","active_tab_id":"bt","label":"hermes-sanbi-bootstrap","pane_count":1,"tab_count":1}]
        return [{"workspace_id":"w","active_tab_id":"t","label":"demo-key","pane_count":2,"tab_count":1}]
    def snapshot(self):
        ws=self.list_workspaces()
        if not ws: return {"workspaces":[],"layouts":[],"panes":[],"agents":[]}
        if self.phase == "boot":
            return {"workspaces":ws,"layouts":[{"workspace_id":"boot","tab_id":"bt","panes":[{"pane_id":"boot:p"}]}],
                    "panes":[{"pane_id":"boot:p","label":"shell","terminal_id":"bterm","cwd":str(self.root)}],"agents":[]}
        value={"workspaces":ws,"layouts":[{"workspace_id":"w","tab_id":"t","panes":[{"pane_id":"w:l"},{"pane_id":"w:c"}]}],
               "panes":[{"pane_id":"w:l","label":"LEAD","terminal_id":"lt","cwd":str(self.root)},
                        {"pane_id":"w:c","label":"CODER","terminal_id":"ct","cwd":str(self.root)}],
               "agents":[self.lead,self.coder]}
        if self.snapshot_mutator is not None: self.snapshot_mutator(value)
        return value
    def get_agent(self,target):
        self.calls.append(("get",target))
        if self.got is not None: return self.got.pop(0)
        return self.lead if target in ("w:l", "lead-id") else self.coder
    def send_text(self,pane,text): self.calls.append(("send_text",pane,text))
    def send_keys(self,target,*keys): self.calls.append(("send_keys",target,*keys))
    def create_workspace(self,cwd,label): self.calls.append(("create",cwd,label)); self.phase="boot"; return {"type":"workspace_created","workspace":{},"tab":{},"root_pane":{}}
    def pane_process_info(self,pane): return {"pane_id":pane,"shell_pid":1,"foreground_processes":[{"pid":1,"name":"powershell.exe","argv0":"powershell.exe","cwd":str(self.root)}]}
    def run_pane(self,pane,command): self.calls.append(("run",pane,command)); self.phase="project"
    def read_pane(self,pane,timeout=None): return self.pane_reads.pop(0)


class ExecuteTests(unittest.TestCase):
    def setUp(self):
        self.tmp_obj=tempfile.TemporaryDirectory(); self.tmp=Path(self.tmp_obj.name); self.root=self.tmp/"project"
        (self.root/".agent").mkdir(parents=True)
        (self.root/".agent/config.json").write_text(json.dumps({"project":{"key":"demo-key"},"herdr":{"leadAgent":"lead-id","coderAgent":"coder-id"}}),encoding="utf-8")
        self.registry=self.tmp/"projects.json"; self.registry.write_text(json.dumps({"projects":{"demo":{"path":str(self.root)}}}),encoding="utf-8")
        bridge._IN_FLIGHT.clear()
    def tearDown(self): bridge._IN_FLIGHT.clear(); self.tmp_obj.cleanup()
    def run_execute(self,t,states=("READY",),clock=None):
        values=iter(states); last=[None]
        def status_reader(alias, registry_path=None, runtime_reader=None):
            try: last[0]=next(values)
            except StopIteration: pass
            status=last[0]
            if status is None: active=None
            elif isinstance(status,tuple): active={"active":True,"id":status[0],"status":status[1],"title":"Task"}
            else: active={"active":True,"id":"T-007","status":status,"title":"Task"}
            return {"workflow":{"activeTask":active}}
        clock=clock or Clock()
        return bridge.execute_project("demo",registry_path=self.registry,transport=t,status_reader=status_reader,
                                      monotonic=clock.monotonic,sleep=clock.sleep,
                                      activation_token_factory=lambda:"ActToken123")
    def assert_pre_dispatch_topology_failure(self, t):
        with self.assertRaisesRegex(bridge.BridgeError,"topology"):
            self.run_execute(t,("READY",))
        self.assertFalse(any(isinstance(c,tuple) and c[0] in {"send_text","send_keys","run"} for c in t.calls))

    def test_exact_raw_dispatch_once_and_observes_full_window(self):
        clock=Clock(); t=ExecuteTransport(self.root)
        result=self.run_execute(t,("READY","CODING","CODING"),clock)
        self.assertEqual(result,"The /execute command was sent to the demo Lead.\nT-007 is currently CODING.")
        self.assertEqual([c for c in t.calls if isinstance(c,tuple) and c[0]=="send_text"],[("send_text","w:l","/execute")])
        self.assertEqual([c for c in t.calls if isinstance(c,tuple) and c[0]=="send_keys"],[("send_keys","lead-id","enter")])
        self.assertEqual(clock.value,15.0)
        self.assertFalse(any(isinstance(c,tuple) and c[0] in {"prompt","read"} for c in t.calls))

    def test_online_skips_activation_and_offline_reuses_lazy_activation(self):
        online=ExecuteTransport(self.root); self.run_execute(online,("READY","READY")); self.assertFalse(any(isinstance(c,tuple) and c[0]=="run" for c in online.calls))
        offline=ExecuteTransport(self.root,online=False); self.run_execute(offline,("READY","READY")); self.assertEqual(sum(isinstance(c,tuple) and c[0]=="run" for c in offline.calls),1)

    def test_any_valid_baseline_status_dispatches_without_sanbi_precondition(self):
        for status in ("DRAFT","READY","CODING","BLOCKED","REVIEW","DONE"):
            with self.subTest(status=status):
                t=ExecuteTransport(self.root); self.run_execute(t,(status,status)); self.assertEqual(sum(isinstance(c,tuple) and c[0]=="send_text" for c in t.calls),1)

    def test_busy_lead_fails_without_dispatch(self):
        t=ExecuteTransport(self.root,lead_status="working")
        with self.assertRaisesRegex(bridge.BridgeError,"busy"): self.run_execute(t,("READY",))
        self.assertFalse(any(isinstance(c,tuple) and c[0] in {"send_text","send_keys"} for c in t.calls))

    def test_identity_race_after_text_never_presses_enter(self):
        replacement=agent(session="replacement",cwd=str(self.root))
        t=ExecuteTransport(self.root,got=[agent(cwd=str(self.root)),replacement])
        with self.assertRaisesRegex(bridge.BridgeError,"identity changed"): self.run_execute(t,("READY",))
        self.assertEqual(sum(isinstance(c,tuple) and c[0]=="send_text" for c in t.calls),1)
        self.assertEqual(sum(isinstance(c,tuple) and c[0]=="send_keys" for c in t.calls),0)

    def test_coder_is_observation_only_even_when_working(self):
        t=ExecuteTransport(self.root); self.run_execute(t,("READY","READY"))
        self.assertFalse(any(isinstance(c,tuple) and c[0] in {"send_text","send_keys","prompt"} and "coder" in str(c).lower() for c in t.calls))

    def test_real_split_schema_uses_canonical_pane_labels_when_agents_omit_them(self):
        t=ExecuteTransport(self.root)
        del t.lead["pane_label"]
        del t.coder["pane_label"]

        result=self.run_execute(t,("READY","READY"))

        self.assertEqual(result,"The /execute command was sent to the demo Lead.\nT-007 is currently READY.")
        self.assertEqual([c for c in t.calls if isinstance(c,tuple) and c[0]=="send_text"],[("send_text","w:l","/execute")])
        self.assertEqual([c for c in t.calls if isinstance(c,tuple) and c[0]=="send_keys"],[("send_keys","lead-id","enter")])

    def test_canonical_lead_pane_with_wrong_label_fails_closed_before_dispatch(self):
        def mutate(snapshot):
            snapshot["panes"][0]["label"]="SHELL"
        self.assert_pre_dispatch_topology_failure(ExecuteTransport(self.root,snapshot_mutator=mutate))

    def test_missing_canonical_pane_record_fails_closed_before_dispatch(self):
        def mutate(snapshot):
            snapshot["layouts"][0]["panes"][0]["pane_id"]="w:missing"
        self.assert_pre_dispatch_topology_failure(ExecuteTransport(self.root,snapshot_mutator=mutate))

    def test_agent_reference_to_unresolved_pane_fails_closed_before_dispatch(self):
        t=ExecuteTransport(self.root)
        t.lead["pane_id"]="w:missing"
        self.assert_pre_dispatch_topology_failure(t)

    def test_agent_and_canonical_pane_terminal_mismatch_fails_closed_before_dispatch(self):
        t=ExecuteTransport(self.root)
        t.lead["terminal_id"]="other-terminal"
        self.assert_pre_dispatch_topology_failure(t)

    def test_agent_outside_canonical_workspace_fails_closed_before_dispatch(self):
        t=ExecuteTransport(self.root)
        t.lead["workspace_id"]="other-workspace"
        self.assert_pre_dispatch_topology_failure(t)

    def test_lead_pane_outside_canonical_workspace_fails_closed_before_dispatch(self):
        class MovedPaneTransport(ExecuteTransport):
            def list_workspaces(inner_self):
                values=super().list_workspaces()
                values.append({"workspace_id":"other","active_tab_id":"ot","label":"unrelated",
                               "pane_count":1,"tab_count":1})
                return values
        def mutate(snapshot):
            snapshot["layouts"][0]["panes"][0]["pane_id"]="w:replacement"
            snapshot["layouts"].append({"workspace_id":"other","tab_id":"ot",
                                        "panes":[{"pane_id":"w:l"}]})
            snapshot["panes"].append({"pane_id":"w:replacement","label":"LEAD",
                                      "terminal_id":"lt","cwd":str(self.root)})
        self.assert_pre_dispatch_topology_failure(MovedPaneTransport(self.root,snapshot_mutator=mutate))

    def test_canonical_pane_outside_project_root_fails_closed_before_dispatch(self):
        def mutate(snapshot):
            snapshot["panes"][0]["cwd"]=str(self.tmp/"other-project")
        self.assert_pre_dispatch_topology_failure(ExecuteTransport(self.root,snapshot_mutator=mutate))

    def test_unrelated_same_cwd_plain_shell_workspace_is_ignored(self):
        class ExtraWorkspaceTransport(ExecuteTransport):
            def list_workspaces(inner_self):
                values=super().list_workspaces()
                values.append({"workspace_id":"plain","active_tab_id":"pt","label":"2dweb",
                               "pane_count":1,"tab_count":1})
                return values
        def mutate(snapshot):
            snapshot["layouts"].append({"workspace_id":"plain","tab_id":"pt",
                                        "panes":[{"pane_id":"plain:shell"}]})
            snapshot["panes"].append({"pane_id":"plain:shell","label":"shell",
                                      "terminal_id":"plain-terminal","cwd":str(self.root)})
        t=ExtraWorkspaceTransport(self.root,snapshot_mutator=mutate)

        result=self.run_execute(t,("READY","READY"))

        self.assertEqual(result,"The /execute command was sent to the demo Lead.\nT-007 is currently READY.")
        self.assertEqual([c for c in t.calls if isinstance(c,tuple) and c[0]=="send_text"],
                         [("send_text","w:l","/execute")])

    def test_rollback_delayed_coding_unchanged_and_other_states_report_final(self):
        cases=[(("CODING","READY"),"READY"),(("READY","READY","CODING"),"CODING"),(("READY","READY"),"READY"),(("BLOCKED","REVIEW"),"REVIEW")]
        for states,final in cases:
            with self.subTest(states=states):
                result=self.run_execute(ExecuteTransport(self.root),states)
                self.assertTrue(result.endswith(f"T-007 is currently {final}."))

    def test_task_change_or_disappearance_is_safe_guidance(self):
        for final in (("T-008","CODING"),None):
            with self.subTest(final=final):
                result=self.run_execute(ExecuteTransport(self.root),("READY",final))
                self.assertIn("Check /project demo",result)
                self.assertNotIn("T-007 is currently",result)

    def test_no_active_baseline_fails_before_activation_or_dispatch(self):
        t=ExecuteTransport(self.root,online=False)
        with self.assertRaisesRegex(bridge.BridgeError,"active task"): self.run_execute(t,(None,))
        self.assertEqual(t.calls,[])

    def test_lock_held_through_observation_and_released(self):
        entered=threading.Event(); release=threading.Event()
        class BlockingClock(Clock):
            def sleep(self,seconds): entered.set(); release.wait(2); super().sleep(seconds)
        t=ExecuteTransport(self.root); outcomes=[]
        thread=threading.Thread(target=lambda: outcomes.append(self.run_execute(t,("READY","READY"),BlockingClock())))
        thread.start(); self.assertTrue(entered.wait(1))
        with self.assertRaisesRegex(bridge.BridgeError,"already in flight"): self.run_execute(ExecuteTransport(self.root),("READY",))
        release.set(); thread.join(3); self.assertEqual(len(outcomes),1); self.assertNotIn("demo",bridge._IN_FLIGHT)

    def test_same_project_lock_blocks_resolve_and_baseline_but_other_project_is_independent(self):
        other=self.tmp/"other"; (other/".agent").mkdir(parents=True)
        (other/".agent/config.json").write_text(json.dumps({"project":{"key":"demo-key"},"herdr":{"leadAgent":"lead-id","coderAgent":"coder-id"}}),encoding="utf-8")
        self.registry.write_text(json.dumps({"projects":{"demo":{"path":str(self.root)},"other":{"path":str(other)}}}),encoding="utf-8")
        status_calls=[]
        def status_reader(alias, registry_path=None, runtime_reader=None):
            status_calls.append(alias)
            return {"workflow":{"activeTask":{"active":True,"id":"T-007","status":"READY","title":"Task"}}}
        with bridge._IN_FLIGHT_LOCK: bridge._IN_FLIGHT.add("demo")
        try:
            with self.assertRaisesRegex(bridge.BridgeError,"already in flight"):
                bridge.execute_project("demo",registry_path=self.registry,transport=ExecuteTransport(self.root),status_reader=status_reader)
            self.assertEqual(status_calls,[])
            clock=Clock()
            result=bridge.execute_project("other",registry_path=self.registry,transport=ExecuteTransport(other),status_reader=status_reader,
                                          monotonic=clock.monotonic,sleep=clock.sleep)
            self.assertIn("other Lead",result)
            self.assertTrue(status_calls)
        finally:
            with bridge._IN_FLIGHT_LOCK: bridge._IN_FLIGHT.discard("demo")


class ExecutePluginTests(unittest.TestCase):
    def test_registers_only_execute_as_new_command_and_no_new_tool(self):
        plugin=importlib.import_module("plugin")
        class C:
            def __init__(self): self.tools=[]; self.commands=[]; self.hooks=[]
            def register_tool(self,name,fn,description,parameters,toolset=""): self.tools.append(name)
            def register_command(self,name,handler,description,usage): self.commands.append(name)
            def register_hook(self,name,handler): self.hooks.append(name)
        c=C(); plugin.register(c)
        self.assertEqual(c.tools,["sanbi_projects","sanbi_project_status","sanbi_ask_lead"])
        self.assertEqual(c.commands,["projects","project","lead","execute","next","to-task","to-task-approve"])
        self.assertIn("execute",c.commands)

    def test_execute_syntax_fails_before_bridge_and_unknown_is_owner_safe(self):
        plugin=importlib.import_module("plugin"); original=plugin._execute_project; calls=[]
        try:
            plugin._execute_project=lambda alias: calls.append(alias) or (_ for _ in ()).throw(bridge.BridgeError("Unknown project alias 'bad'"))
            for raw in ("","demo extra"):
                self.assertEqual(asyncio.run(plugin.execute_command(raw)),"Usage: /execute <project>")
            self.assertEqual(calls,[])
            self.assertEqual(asyncio.run(plugin.execute_command("bad")),"Unknown Sanbi project: bad")
        finally: plugin._execute_project=original

    def test_only_registered_execute_handler_can_reach_raw_dispatcher(self):
        plugin=importlib.import_module("plugin")
        class C:
            def __init__(self): self.tools=[]; self.commands=[]; self.hooks=[]
            def register_tool(self,name,fn,description,parameters,toolset=""): self.tools.append((name,fn))
            def register_command(self,name,handler,description,usage): self.commands.append((name,handler))
            def register_hook(self,name,handler): self.hooks.append((name,handler))
        calls=[]; original=plugin._execute_project
        try:
            plugin._execute_project=lambda alias: calls.append(alias) or "sent"
            c=C(); plugin.register(c)
            self.assertEqual([name for name,_ in c.commands if _ is plugin.execute_command],["execute"])
            self.assertFalse(any(fn is plugin.execute_command for _,fn in c.tools))
            for _,hook in c.hooks: hook(user_message="execute demo naturally")
            self.assertEqual(calls,[])
            execute=next(handler for name,handler in c.commands if name=="execute")
            self.assertEqual(asyncio.run(execute("demo")),"sent")
            self.assertEqual(calls,["demo"])
        finally: plugin._execute_project=original

    def test_unknown_project_fails_before_transport_activation_or_raw_dispatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/"demo"; (root/".agent").mkdir(parents=True)
            registry=Path(tmp)/"projects.json"
            registry.write_text(json.dumps({"projects":{"demo":{"path":str(root)}}}),encoding="utf-8")
            t=ExecuteTransport(root,online=False)
            with self.assertRaisesRegex(bridge.BridgeError,"Unknown project alias 'missing'"):
                bridge.execute_project("missing",registry_path=registry,transport=t,
                                       status_reader=lambda *args: (_ for _ in ()).throw(AssertionError("baseline read")))
            self.assertEqual(t.calls,[])


class ExecuteCliTransportTests(unittest.TestCase):
    def test_091_raw_methods_have_exact_argv_and_no_prompt_model_or_sentinel(self):
        calls=[]
        class Done: stdout=""; stderr=""; returncode=0
        def run(argv,**kwargs): calls.append(argv); return Done()
        t=bridge.HerdrTransport(run=run)
        t.send_text("w:l","/execute"); t.send_keys("lead-id","enter")
        self.assertEqual([c[1:] for c in calls],[["pane","send-text","w:l","/execute"],["agent","send-keys","lead-id","enter"]])
        joined=" ".join(" ".join(c) for c in calls).lower()
        self.assertNotIn("prompt",joined); self.assertNotIn("sentinel",joined); self.assertNotIn("model",joined)


if __name__ == "__main__": unittest.main()
