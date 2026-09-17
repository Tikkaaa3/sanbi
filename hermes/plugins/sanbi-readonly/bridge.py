"""Request-scoped sentinel bridge to an existing Sanbi Lead.

The in-flight lock is process-local by design: it serializes one Hermes gateway
process only and does not coordinate multiple gateway processes.
"""
from __future__ import annotations

import json
import hashlib
import logging
import math
import os
import re
import secrets
import subprocess
import time
import threading
from pathlib import Path
from typing import Any, Callable

try:
    from . import core
except ImportError:
    import core


LEAD_RESPONSE_TIMEOUT_SECONDS = 600.0
EXECUTE_OBSERVATION_SECONDS = 15.0
EXECUTE_POLL_SECONDS = 0.5
NEXT_OBSERVATION_SECONDS = 90.0
NEXT_POLL_SECONDS = 0.5
SAFE_TIMEOUT = "complete response within 10 minutes"
BOOTSTRAP_LABEL = "hermes-sanbi-bootstrap"
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{12}$")
_ACTIVATION_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{8,24}$")
_BLOCKED_COMMANDS = {"execute", "next", "to-task", "to-spec", "to-tickets", "task-reset", "subagents"}
_IN_FLIGHT: set[str] = set()
_IN_FLIGHT_LOCK = threading.RLock()
_LOGGER = logging.getLogger(__name__)


class BridgeError(RuntimeError):
    pass


class HerdrTimeout(BridgeError):
    """A bounded Herdr CLI call timed out; callers may poll again."""
    pass


def _lock_alias(alias: str) -> str:
    return alias.casefold() if isinstance(alias, str) else alias


def new_token() -> str:
    """Return exactly twelve URL-safe random characters."""
    while True:
        value = secrets.token_urlsafe(9)
        if _TOKEN_RE.fullmatch(value):
            return value


def wrap_message(message: str, token: str) -> str:
    return (
        "Reply with exactly one pair around your final answer only, each marker on its own line. "
        f"Construct the opening marker by concatenate fragments '<<', 'H:', '{token}', '>>'. "
        f"Construct the closing marker by concatenate fragments '<</', 'H:', '{token}', '>>'. "
        "This is a remote owner turn delivered through Hermes/Telegram. Do not invoke ask_user or any "
        "other interactive mechanism that waits for local owner input during this turn, and do not wait "
        "for terminal input. If clarification, approval, or another owner decision is needed, do not block: "
        "return the question or decision request as your final owner-facing response inside the Hermes "
        "response markers, then stop the turn normally. The owner can answer in a later Telegram message. "
        "If the owner message already explicitly authorizes the requested action, do not ask for duplicate "
        "confirmation solely because it arrived through Hermes. "
        "Do not quote these instructions in the answer.\n\n"
        f"Owner message (preserve exactly):\n{message}"
    )


def accumulate(accumulated: str, snapshot: str) -> str:
    """Append a growing or sliding snapshot using maximal boundary overlap."""
    if not accumulated:
        return snapshot
    if snapshot == accumulated or accumulated.endswith(snapshot):
        return accumulated
    maximum = min(len(accumulated), len(snapshot))
    for size in range(maximum, 0, -1):
        if accumulated.endswith(snapshot[:size]):
            return accumulated + snapshot[size:]
    return accumulated + "\n" + snapshot


def _installed_herdr() -> Path:
    root = Path.home() / ".herdr" / "packages" / "standalone" / "releases"
    candidate = root / "0.9.1-x86_64-pc-windows-msvc" / "herdr.exe"
    if not candidate.is_file():
        raise BridgeError("Herdr 0.9.1 installed release is unavailable")
    return candidate


class HerdrTransport:
    def __init__(self, run: Callable[..., Any] = subprocess.run, executable: Path | None = None,
                 timeout: float = 5.0):
        self.run = run
        self.executable = Path(executable) if executable is not None else _installed_herdr()
        self.timeout = timeout

    def _call(self, *args: str, json_result: bool = True, timeout: float | None = None) -> Any:
        operation = args[1] if len(args) > 1 else args[0]
        kwargs: dict[str, Any] = {
            "shell": False, "capture_output": True, "text": True,
            "timeout": (self.timeout if timeout is None else
                        (timeout if args[:2] == ("workspace", "create") else min(self.timeout, timeout))),
            "check": False,
        }
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        try:
            completed = self.run([str(self.executable), *args], **kwargs)
        except subprocess.TimeoutExpired as exc:
            _LOGGER.warning("Herdr transport timeout operation=%s executable=%s", operation, self.executable)
            raise HerdrTimeout(f"Herdr {operation} timed out") from exc
        if completed.returncode != 0:
            _LOGGER.warning("Herdr transport failure operation=%s returncode=%s executable=%s",
                            operation, completed.returncode, self.executable)
            raise BridgeError(f"Herdr {operation} failed")
        if not json_result:
            return completed.stdout
        try:
            envelope = json.loads(completed.stdout)
            result = envelope["result"]
        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            raise BridgeError("Herdr returned an invalid structured response") from exc
        if not isinstance(result, dict):
            raise BridgeError("Herdr returned an invalid structured response")
        return result

    def list_agents(self) -> list[dict[str, Any]]:
        result = self._call("agent", "list")
        if result.get("type") != "agent_list" or not isinstance(result.get("agents"), list):
            raise BridgeError("Herdr agent list response is invalid")
        return result["agents"]

    def get_agent(self, target: str) -> dict[str, Any]:
        result = self._call("agent", "get", target)
        if result.get("type") != "agent_info" or not isinstance(result.get("agent"), dict):
            raise BridgeError("Herdr agent get response is invalid")
        return result["agent"]

    def prompt(self, target: str, text: str) -> dict[str, Any]:
        return self._call("agent", "prompt", target, text)

    def send_text(self, pane: str, text: str) -> str:
        return self._call("pane", "send-text", pane, text, json_result=False)

    def send_keys(self, target: str, *keys: str) -> str:
        return self._call("agent", "send-keys", target, *keys, json_result=False)


    def read(self, target: str, timeout: float | None = None) -> str:
        return self._call("agent", "read", target, "--source", "recent-unwrapped", "--format", "text",
                          json_result=False, timeout=timeout)

    def list_workspaces(self) -> list[dict[str, Any]]:
        result = self._call("workspace", "list")
        values = result.get("workspaces")
        if result.get("type") != "workspace_list" or not isinstance(values, list):
            raise BridgeError("Herdr workspace list response is invalid")
        return values

    def snapshot(self) -> dict[str, Any]:
        result = self._call("api", "snapshot")
        value = result.get("snapshot")
        if result.get("type") != "session_snapshot" or not isinstance(value, dict):
            raise BridgeError("Herdr session snapshot response is invalid")
        if not all(isinstance(value.get(k), list) for k in ("workspaces", "layouts", "panes", "agents")):
            raise BridgeError("Herdr session snapshot response is invalid")
        return value

    def create_workspace(self, cwd: str, label: str) -> dict[str, Any]:
        result = self._call("workspace", "create", "--cwd", cwd, "--label", label, "--no-focus", timeout=10.0)
        if result.get("type") != "workspace_created" or not all(isinstance(result.get(k), dict) for k in ("workspace", "tab", "root_pane")):
            raise BridgeError("Herdr workspace create response is invalid")
        return result

    def pane_process_info(self, pane: str) -> dict[str, Any]:
        result = self._call("pane", "process-info", "--pane", pane)
        value = result.get("process_info")
        if result.get("type") != "pane_process_info" or not isinstance(value, dict):
            raise BridgeError("Herdr pane process response is invalid")
        return value

    def run_pane(self, pane: str, command: str) -> str:
        # Herdr 0.9.1 accepts the command but emits no structured response.
        return self._call("pane", "run", pane, command, json_result=False)

    def read_pane(self, pane: str, timeout: float | None = None) -> str:
        return self._call("pane", "read", pane, "--source", "recent-unwrapped", "--lines", "160",
                          "--format", "text", json_result=False, timeout=timeout)


def _resolve(alias: str, registry_path: Path | None) -> tuple[Path, str, str, str]:
    try:
        resolved = core.resolve_project(alias, registry_path)
        project = core.validate_project_paths(resolved)
    except core.SanbiError as exc:
        message = str(exc).removeprefix("Sanbi status unavailable: ")
        raise BridgeError(message) from exc
    try:
        config = json.loads((project / ".agent" / "config.json").read_text(encoding="utf-8"))
        lead = config["herdr"]["leadAgent"]
        coder = config["herdr"]["coderAgent"]
        key = config["project"]["key"]
    except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError) as exc:
        raise BridgeError("Configured Lead identity is unavailable") from exc
    if any(not isinstance(value, str) or not value.strip() for value in (lead, coder, key)):
        raise BridgeError("Configured runtime identity is unavailable")
    return project, key, lead, coder


def _identity(info: dict[str, Any]) -> tuple[Any, Any, Any, Any]:
    session = info.get("agent_session")
    if not isinstance(session, dict) or any(not isinstance(session.get(key), str) or not session[key]
                                            for key in ("agent", "kind", "source", "value")):
        raise BridgeError("Lead structured agent_session identity is invalid")
    pane = info.get("pane_id")
    terminal = info.get("terminal_id")
    name = info.get("name")
    if any(not isinstance(value, str) or not value for value in (name, pane, terminal)):
        raise BridgeError("Lead identity is invalid")
    return name, pane, terminal, tuple((key, session[key]) for key in ("agent", "kind", "source", "value"))


def _validate_preflight(info: dict[str, Any], lead: str, alias: str) -> tuple[Any, ...]:
    identity = _identity(info)
    if identity[0] != lead:
        raise BridgeError("Lead identity does not match configuration")
    if info.get("interactive_ready") is not True:
        raise BridgeError("Lead is not interactive-ready")
    pending = info.get("launch_pending", False)
    if type(pending) is not bool or pending:
        raise BridgeError("Lead launch is pending or invalid")
    status = info.get("agent_status")
    if status == "working":
        raise BridgeError(f"{alias} Lead is currently busy. Try again after the current Lead turn finishes.")
    if status not in {"idle", "done"}:
        raise BridgeError("Lead status is unsafe")
    skipped = info.get("screen_detection_skipped", False)
    if type(skipped) is not bool:
        raise BridgeError("Lead screen detection state is invalid")
    # Native Pi sessions expose authoritative structured readiness even when
    # terminal screen detection is intentionally skipped. No other source does.
    session = info["agent_session"]
    if session["source"] != "herdr:pi" or session["agent"] != "pi":
        raise BridgeError("Agent session source is unsafe")
    if skipped and session["source"] != "herdr:pi":
        raise BridgeError("Lead screen detection was skipped for an unsafe session source")
    return identity


def _parse_markers(text: str, token: str) -> str | None:
    opening = f"<<H:{token}>>"
    closing = f"<</H:{token}>>"
    opens = text.count(opening)
    closes = text.count(closing)
    if closes > opens or opens > 1 or closes > 1:
        raise BridgeError("Lead response markers are ambiguous")
    if opens == 0 or closes == 0:
        return None
    start = text.index(opening) + len(opening)
    end = text.index(closing)
    if end < start:
        raise BridgeError("Lead response markers are ambiguous")
    answer = text[start:end].strip()
    if not answer:
        raise BridgeError("Lead returned an empty answer")
    return answer


def _reject_command(message: str) -> None:
    match = re.match(r"^\s*/([A-Za-z0-9-]+)(?=\s|$)", message)
    if match and match.group(1).casefold() in _BLOCKED_COMMANDS:
        raise BridgeError("Direct Sanbi workflow commands are not allowed through the Lead bridge")


def _delivered_timeout(alias: str) -> str:
    return (f"The message was delivered to the {alias} Lead, but Hermes did not receive a complete response "
            "within 10 minutes. The request was not retried or cancelled, and the Lead may still finish "
            "locally afterward.")


def _joined_workspaces(transport: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    summaries = transport.list_workspaces()
    snapshot = transport.snapshot()
    if not isinstance(summaries, list):
        raise BridgeError("Herdr runtime snapshot is malformed")
    layouts = snapshot["layouts"]; pane_values = snapshot["panes"]; agents = snapshot["agents"]
    panes = {p.get("pane_id"): p for p in pane_values if isinstance(p, dict) and isinstance(p.get("pane_id"), str)}
    if len(panes) != len(pane_values) or not all(isinstance(a, dict) for a in agents):
        raise BridgeError("Herdr runtime snapshot is malformed")
    joined = []
    for summary in summaries:
        if not isinstance(summary, dict): raise BridgeError("Herdr workspace topology is malformed")
        wsid, tabid = summary.get("workspace_id"), summary.get("active_tab_id")
        if not all(isinstance(v, str) and v for v in (wsid, tabid, summary.get("label"))):
            raise BridgeError("Herdr workspace topology is malformed")
        if (type(summary.get("pane_count")) is not int or summary["pane_count"] < 0 or
                type(summary.get("tab_count")) is not int or summary["tab_count"] < 1):
            raise BridgeError("Herdr workspace topology is malformed")
        matches = [x for x in layouts if isinstance(x, dict) and x.get("workspace_id") == wsid and x.get("tab_id") == tabid]
        if len(matches) != 1 or not isinstance(matches[0].get("panes"), list):
            raise BridgeError("Herdr workspace topology is malformed")
        values = []
        for ref in matches[0]["panes"]:
            pid = ref.get("pane_id") if isinstance(ref, dict) else None
            if pid not in panes: raise BridgeError("Herdr workspace topology is malformed")
            values.append(panes[pid])
        if len(values) != summary["pane_count"]:
            raise BridgeError("Herdr workspace topology is malformed")
        item = dict(summary); item["panes"] = values; joined.append(item)
    return joined, agents


def _runtime(transport: Any, project: Path, key: str, lead: str, coder: str,
             alias: str) -> tuple[tuple[Any, ...], bool]:
    workspaces, agents = _joined_workspaces(transport)
    project_ws = [w for w in workspaces if isinstance(w, dict) and w.get("label") == key]
    leads = [a for a in agents if isinstance(a, dict) and a.get("name") == lead]
    coders = [a for a in agents if isinstance(a, dict) and a.get("name") == coder]
    if not project_ws and not leads and not coders:
        return (), False
    if len(leads) > 1:
        raise BridgeError("More than one live agent matched the configured Lead identity")
    if len(project_ws) != 1 or len(leads) != 1 or len(coders) != 1:
        raise BridgeError("Sanbi runtime topology is malformed")
    ws = project_ws[0]; wsid = ws.get("workspace_id")
    if not isinstance(wsid, str) or not wsid:
        raise BridgeError("Sanbi runtime topology is malformed")
    panes = ws["panes"]
    if len(panes) != 2 or {p.get("label") for p in panes} != {"LEAD", "CODER"}:
        raise BridgeError("Sanbi runtime topology is malformed")
    by_label = {p["label"]: p for p in panes}
    expected_root = os.path.normcase(os.path.abspath(str(project)))
    for role, info, expected_name in (("LEAD", leads[0], lead), ("CODER", coders[0], coder)):
        pane = by_label[role]
        values = (pane.get("pane_id"), pane.get("terminal_id"), pane.get("cwd"))
        if any(not isinstance(v, str) or not v for v in values):
            raise BridgeError("Sanbi runtime topology is malformed")
        if os.path.normcase(os.path.abspath(values[2])) != expected_root:
            raise BridgeError("Sanbi runtime topology is malformed")
        if (info.get("name") != expected_name or info.get("workspace_id", wsid) != wsid or
                info.get("pane_id") != pane["pane_id"] or info.get("terminal_id") != pane["terminal_id"] or
                info.get("pane_label", role) != role or
                os.path.normcase(os.path.abspath(str(info.get("cwd", project)))) != expected_root):
            raise BridgeError("Sanbi runtime topology is malformed")
        _validate_preflight(info, expected_name, alias)
    return _identity(leads[0]), True


def _execute_runtime(transport: Any, project: Path, key: str, lead: str, coder: str,
                     alias: str) -> tuple[tuple[Any, ...], bool]:
    """Validate exact topology while treating Coder as observation-only."""
    workspaces, agents = _joined_workspaces(transport)
    project_ws = [w for w in workspaces if w.get("label") == key]
    leads = [a for a in agents if a.get("name") == lead]
    coders = [a for a in agents if a.get("name") == coder]
    if not project_ws and not leads and not coders:
        return (), False
    if len(project_ws) != 1 or len(leads) != 1 or len(coders) != 1:
        raise BridgeError("Sanbi runtime topology is malformed")
    ws = project_ws[0]
    wsid = ws.get("workspace_id")
    panes = ws.get("panes")
    if (not isinstance(wsid, str) or not wsid or not isinstance(panes, list) or len(panes) != 2 or
            {p.get("label") for p in panes if isinstance(p, dict)} != {"LEAD", "CODER"}):
        raise BridgeError("Sanbi runtime topology is malformed")
    by_label = {p["label"]: p for p in panes}
    expected_root = os.path.normcase(os.path.abspath(str(project)))
    for role, info, expected_name in (("LEAD", leads[0], lead), ("CODER", coders[0], coder)):
        pane = by_label[role]
        if (info.get("name") != expected_name or info.get("workspace_id") != wsid or
                info.get("pane_id") != pane.get("pane_id") or
                info.get("terminal_id") != pane.get("terminal_id") or
                not isinstance(pane.get("cwd"), str) or
                os.path.normcase(os.path.abspath(pane["cwd"])) != expected_root or
                not isinstance(info.get("cwd"), str) or
                os.path.normcase(os.path.abspath(info["cwd"])) != expected_root):
            raise BridgeError("Sanbi runtime topology is malformed")
        identity = _identity(info)
        session = info["agent_session"]
        if session["agent"] != "pi" or session["kind"] != "id" or session["source"] != "herdr:pi":
            raise BridgeError("Agent session source is unsafe")
        if role == "LEAD":
            if info.get("interactive_ready") is not True:
                raise BridgeError("Lead is not interactive-ready")
            pending = info.get("launch_pending", False)
            if type(pending) is not bool or pending:
                raise BridgeError("Lead launch is pending or invalid")
            if info.get("agent_status") == "working":
                raise BridgeError(f"{alias} Lead is currently busy. Try again after the current Lead turn finishes.")
            if info.get("agent_status") != "idle":
                raise BridgeError("Lead status is unsafe")
            lead_identity = identity
    return lead_identity + (wsid, expected_root), True


def _validate_execute_recheck(info: dict[str, Any], expected: tuple[Any, ...],
                              lead: str, alias: str) -> None:
    identity = _identity(info)
    root = expected[5]
    if (identity != expected[:4] or info.get("workspace_id") != expected[4] or
            not isinstance(info.get("cwd"), str) or
            os.path.normcase(os.path.abspath(info["cwd"])) != root):
        raise BridgeError("Lead identity changed during execute dispatch")
    session = info["agent_session"]
    if (identity[0] != lead or session["agent"] != "pi" or session["kind"] != "id" or
            session["source"] != "herdr:pi"):
        raise BridgeError("Lead identity changed during execute dispatch")
    if info.get("interactive_ready") is not True:
        raise BridgeError("Lead is not interactive-ready")
    pending = info.get("launch_pending", False)
    if type(pending) is not bool or pending:
        raise BridgeError("Lead launch is pending or invalid")
    if info.get("agent_status") == "working":
        raise BridgeError(f"{alias} Lead is currently busy. Try again after the current Lead turn finishes.")
    if info.get("agent_status") != "idle":
        raise BridgeError("Lead status is unsafe")


def _next_runtime_snapshot(transport: Any, project: Path, key: str, lead: str,
                           coder: str, alias: str, *, dispatch_ready: bool) -> dict[str, tuple[Any, ...]]:
    """Read exact Lead/Coder topology; session rotation is data, not an error."""
    workspaces, agents = _joined_workspaces(transport)
    project_ws = [value for value in workspaces if value.get("label") == key]
    by_name = {name: [value for value in agents if value.get("name") == name]
               for name in (lead, coder)}
    if len(project_ws) != 1 or any(len(values) != 1 for values in by_name.values()):
        raise BridgeError("Sanbi runtime topology is malformed")
    workspace = project_ws[0]
    panes = workspace.get("panes")
    if (not isinstance(workspace.get("workspace_id"), str) or
            not isinstance(panes, list) or len(panes) != 2 or
            {pane.get("label") for pane in panes if isinstance(pane, dict)} != {"LEAD", "CODER"}):
        raise BridgeError("Sanbi runtime topology is malformed")
    pane_by_role = {pane["label"]: pane for pane in panes}
    expected_root = os.path.normcase(os.path.abspath(str(project)))
    result: dict[str, tuple[Any, ...]] = {}
    for role, name in (("LEAD", lead), ("CODER", coder)):
        info = by_name[name][0]
        pane = pane_by_role[role]
        identity = _identity(info)
        session = info["agent_session"]
        if (info.get("workspace_id") != workspace["workspace_id"] or
                info.get("pane_id") != pane.get("pane_id") or
                info.get("terminal_id") != pane.get("terminal_id") or
                not isinstance(pane.get("cwd"), str) or
                os.path.normcase(os.path.abspath(pane["cwd"])) != expected_root or
                not isinstance(info.get("cwd"), str) or
                os.path.normcase(os.path.abspath(info["cwd"])) != expected_root or
                session["agent"] != "pi" or session["kind"] != "id" or
                session["source"] != "herdr:pi"):
            raise BridgeError("Sanbi runtime topology is malformed")
        result[role] = identity + (workspace["workspace_id"], expected_root)
    if dispatch_ready:
        _validate_execute_recheck(by_name[lead][0], result["LEAD"], lead, alias)
    return result


def _next_result(alias: str, baseline_id: str, tasks: Any,
                 baseline_runtime: dict[str, tuple[Any, ...]],
                 final_runtime: dict[str, tuple[Any, ...]] | None) -> str:
    prefix = f"The /next command was sent to the {alias} Lead."
    unknown_previous = ("The /next command was sent, but Hermes could not verify the "
                        "previous task state afterward.\n"
                        f"Check /project {alias} for the current status.")
    if not isinstance(tasks, list) or any(not isinstance(task, dict) for task in tasks):
        return unknown_previous
    matches = [task for task in tasks if task.get("id") == baseline_id]
    if len(matches) != 1:
        return unknown_previous
    active_others = [task for task in tasks
                     if task.get("active") is True and task.get("id") != baseline_id]
    if active_others:
        if len(active_others) == 1 and isinstance(active_others[0].get("id"), str):
            return (f"{prefix}\n{active_others[0]['id']} is now active; the previous task "
                    f"{baseline_id} is {'still active' if matches[0].get('active') is True else 'inactive'}.\n"
                    f"Check /project {alias} for the current state before taking another lifecycle action.")
        return (f"{prefix}\nThe observed task state is ambiguous because multiple other tasks are active.\n"
                f"Check /project {alias} for the current state before taking another lifecycle action.")
    if final_runtime is None:
        return f"{prefix}\nThe final runtime snapshot is malformed. Check /project {alias} for current status."
    active = matches[0].get("active") is True
    lead_changed = final_runtime["LEAD"][3] != baseline_runtime["LEAD"][3]
    coder_changed = final_runtime["CODER"][3] != baseline_runtime["CODER"][3]
    if not active and lead_changed and coder_changed:
        return (f"{prefix}\n{baseline_id} is now inactive.\n"
                "Both configured agent sessions changed.")
    if active and coder_changed and not lead_changed:
        return (f"{prefix}\n{baseline_id} is still active, but the Coder session changed.\n"
                f"The runtime appears to be in a partial transition. Check /project {alias} before sending /next again.")
    if not active and coder_changed and not lead_changed:
        return (f"{prefix}\n{baseline_id} is inactive and the Coder session changed, but the Lead session did not rotate.\n"
                f"Check /project {alias} before taking another lifecycle action.")
    if active and not lead_changed and not coder_changed:
        return (f"{prefix}\nNo completed /next transition was observed during the verification window.\n"
                f"Check /project {alias} for the current state.")
    if lead_changed and not coder_changed:
        state = "still active" if active else "inactive"
        return (f"{prefix}\n{baseline_id} is {state} and the Lead session changed, but the Coder session did not rotate.\n"
                f"This is a partial or ambiguous transition. Check /project {alias} before taking another lifecycle action.")
    if not active:
        return (f"{prefix}\n{baseline_id} is inactive, but neither configured agent session changed.\n"
                f"This is a partial or ambiguous transition. Check /project {alias} before taking another lifecycle action.")
    return (f"{prefix}\n{baseline_id} is still active, although both configured agent sessions changed.\n"
            f"This is a partial or ambiguous transition. Check /project {alias} before taking another lifecycle action.")


def next_project(alias: str, *, registry_path: Path | None = None,
                 transport: Any | None = None,
                 task_reader: Callable[[Path], list[dict[str, Any]]] | None = None,
                 monotonic: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep,
                 activation_token_factory: Callable[[], str] = new_token) -> str:
    """Submit fixed Pi /next once, then report the bounded final snapshot."""
    with _IN_FLIGHT_LOCK:
        if _lock_alias(alias) in _IN_FLIGHT:
            raise BridgeError(f"A Lead request is already in flight for {alias!r}")
        _IN_FLIGHT.add(_lock_alias(alias))
    try:
        project, key, lead, coder = _resolve(alias, registry_path)
        task_reader = task_reader or (lambda root: core._read_tasks(root / ".agent"))
        baseline_tasks = task_reader(project)
        active = ([task for task in baseline_tasks
                   if isinstance(task, dict) and task.get("active") is True]
                  if isinstance(baseline_tasks, list) else [])
        if len(active) != 1 or not isinstance(active[0].get("id"), str):
            raise BridgeError(f"{alias} has no active task to observe; check /project {alias}.")
        baseline_id = active[0]["id"]
        transport = transport or HerdrTransport()
        activation_deadline = monotonic() + 45.0
        expected, online = _execute_runtime(transport, project, key, lead, coder, alias)
        if not online:
            _activate(transport, project, activation_token_factory(), activation_deadline,
                      monotonic, sleep, NEXT_POLL_SECONDS)
            while True:
                expected, online = _execute_runtime(transport, project, key, lead, coder, alias)
                if online:
                    break
                if monotonic() >= activation_deadline:
                    raise BridgeError("Sanbi runtime readiness timed out")
                sleep(min(NEXT_POLL_SECONDS, activation_deadline - monotonic()))
        baseline_runtime = _next_runtime_snapshot(
            transport, project, key, lead, coder, alias, dispatch_ready=True)
        pane = baseline_runtime["LEAD"][1]
        _validate_execute_recheck(transport.get_agent(lead), baseline_runtime["LEAD"], lead, alias)
        transport.send_text(pane, "/next")
        _validate_execute_recheck(transport.get_agent(lead), baseline_runtime["LEAD"], lead, alias)
        transport.send_keys(lead, "enter")
        deadline = monotonic() + NEXT_OBSERVATION_SECONDS
        while monotonic() < deadline:
            task_reader(project)
            try:
                _next_runtime_snapshot(transport, project, key, lead, coder, alias, dispatch_ready=False)
            except BridgeError:
                pass
            sleep(min(NEXT_POLL_SECONDS, deadline - monotonic()))
        final_tasks = task_reader(project)
        try:
            final_runtime = _next_runtime_snapshot(
                transport, project, key, lead, coder, alias, dispatch_ready=False)
        except BridgeError:
            final_runtime = None
        return _next_result(alias, baseline_id, final_tasks, baseline_runtime, final_runtime)
    finally:
        with _IN_FLIGHT_LOCK:
            _IN_FLIGHT.discard(_lock_alias(alias))


def _plain_bootstrap(transport: Any, project: Path) -> str:
    workspaces, agents = _joined_workspaces(transport)
    digest = hashlib.sha256(os.path.normcase(os.path.abspath(str(project))).encode("utf-8")).hexdigest()[:12]
    project_label = f"{BOOTSTRAP_LABEL}-{digest}"
    candidates = [w for w in workspaces if isinstance(w, dict) and w.get("label") in {BOOTSTRAP_LABEL, project_label}]
    expected_root = os.path.normcase(os.path.abspath(str(project)))
    matches = [w for w in candidates if len(w.get("panes", [])) == 1 and
               isinstance(w["panes"][0].get("cwd"), str) and
               os.path.normcase(os.path.abspath(w["panes"][0]["cwd"])) == expected_root]
    if len(matches) > 1:
        raise BridgeError("Duplicate Hermes bootstrap workspaces")
    if not matches and any(w.get("label") == project_label for w in candidates):
        raise BridgeError("Hermes project bootstrap workspace has an unsafe cwd")
    if not matches:
        label = BOOTSTRAP_LABEL if not candidates else project_label
        transport.create_workspace(str(project), label)
        workspaces, agents = _joined_workspaces(transport)
        matches = [w for w in workspaces if isinstance(w, dict) and w.get("label") == label]
    if len(matches) != 1:
        raise BridgeError("Hermes bootstrap workspace is unavailable")
    ws = matches[0]; panes = ws["panes"]
    if len(panes) != 1:
        raise BridgeError("Hermes bootstrap workspace is unsafe")
    pane = panes[0]; pane_id = pane.get("pane_id"); terminal = pane.get("terminal_id")
    if any(not isinstance(v, str) or not v for v in (ws.get("workspace_id"), pane_id, terminal)):
        raise BridgeError("Hermes bootstrap identity is invalid")
    if (not isinstance(pane.get("cwd"), str) or
            os.path.normcase(os.path.abspath(pane["cwd"])) != os.path.normcase(os.path.abspath(str(project)))):
        raise BridgeError("Hermes bootstrap cwd is unsafe")
    if any(a.get("pane_id") == pane_id for a in agents):
        raise BridgeError("Hermes bootstrap pane is occupied by an agent")
    info = transport.pane_process_info(pane_id)
    shell_pid = info.get("shell_pid"); processes = info.get("foreground_processes")
    if (info.get("pane_id") != pane_id or not isinstance(shell_pid, int) or
            not isinstance(processes, list) or len(processes) != 1 or not isinstance(processes[0], dict)):
        raise BridgeError("Hermes bootstrap process state is unsafe")
    def exe(value: Any) -> str: return os.path.basename(str(value)).casefold()
    allowed = {"powershell.exe", "pwsh.exe"}
    process = processes[0]
    if (process.get("pid") != shell_pid or exe(process.get("name")) not in allowed or
            exe(process.get("argv0")) not in allowed or not isinstance(process.get("cwd"), str) or
            os.path.normcase(os.path.abspath(process["cwd"])) != os.path.normcase(os.path.abspath(str(project)))):
        raise BridgeError("Hermes bootstrap process state is unsafe")
    return pane_id


def _activate(transport: Any, project: Path, token: str, deadline: float,
              monotonic: Callable[[], float], sleep: Callable[[float], None], interval: float) -> None:
    if not isinstance(token, str) or not _ACTIVATION_TOKEN_RE.fullmatch(token):
        raise BridgeError("Generated activation token is invalid")
    pane = _plain_bootstrap(transport, project)
    quoted = str(project).replace("'", "''")
    ok, fail = f"__HS_OK_{token}", f"__HS_FAIL_{token}"
    baseline = transport.read_pane(pane, timeout=max(0.001, deadline - monotonic()))
    if not isinstance(baseline, str) or ok in baseline or fail in baseline:
        raise BridgeError("Generated activation marker collides with bootstrap baseline")
    command = (f"Set-Location -LiteralPath '{quoted}'; $global:LASTEXITCODE = $null; sanbi; $code=$LASTEXITCODE; "
               f"if (($code -is [int]) -and ($code -eq 0)) {{ Write-Output ('__HS_' + 'OK_' + '{token}') }} "
               f"else {{ Write-Output ('__HS_' + 'FAIL_' + '{token}') }}")
    transport.run_pane(pane, command)
    end = deadline
    while monotonic() < end:
        output = transport.read_pane(pane, timeout=end - monotonic())
        if fail in output: raise BridgeError("Sanbi activation failed")
        if ok in output: return
        sleep(min(interval, end - monotonic()))
    raise BridgeError("Sanbi activation timed out")


def execute_project(alias: str, *, registry_path: Path | None = None,
                    transport: Any | None = None,
                    status_reader: Callable[..., dict[str, Any]] | None = None,
                    monotonic: Callable[[], float] = time.monotonic,
                    sleep: Callable[[float], None] = time.sleep,
                    activation_token_factory: Callable[[], str] = new_token) -> str:
    """Submit the fixed Pi /execute command once and observe durable state."""
    with _IN_FLIGHT_LOCK:
        if _lock_alias(alias) in _IN_FLIGHT:
            raise BridgeError(f"A Lead request is already in flight for {alias!r}")
        _IN_FLIGHT.add(_lock_alias(alias))
    try:
        project, key, lead, coder = _resolve(alias, registry_path)
        status_reader = status_reader or core.read_project_status
        baseline_payload = status_reader(alias, registry_path, lambda _: {})
        baseline = baseline_payload.get("workflow", {}).get("activeTask")
        if not isinstance(baseline, dict) or not isinstance(baseline.get("id"), str):
            raise BridgeError(f"{alias} has no active task to observe; check /project {alias}.")
        baseline_id = baseline["id"]

        transport = transport or HerdrTransport()
        activation_deadline = monotonic() + 45.0
        expected, online = _execute_runtime(transport, project, key, lead, coder, alias)
        if not online:
            _activate(transport, project, activation_token_factory(), activation_deadline,
                      monotonic, sleep, EXECUTE_POLL_SECONDS)
            while True:
                expected, online = _execute_runtime(transport, project, key, lead, coder, alias)
                if online:
                    break
                if monotonic() >= activation_deadline:
                    raise BridgeError("Sanbi runtime readiness timed out")
                sleep(min(EXECUTE_POLL_SECONDS, activation_deadline - monotonic()))

        pane = expected[1]
        _validate_execute_recheck(transport.get_agent(lead), expected, lead, alias)
        transport.send_text(pane, "/execute")
        _validate_execute_recheck(transport.get_agent(lead), expected, lead, alias)
        transport.send_keys(lead, "enter")

        deadline = monotonic() + EXECUTE_OBSERVATION_SECONDS
        final = baseline
        while monotonic() < deadline:
            payload = status_reader(alias, registry_path, lambda _: {})
            final = payload.get("workflow", {}).get("activeTask")
            sleep(min(EXECUTE_POLL_SECONDS, deadline - monotonic()))
        payload = status_reader(alias, registry_path, lambda _: {})
        final = payload.get("workflow", {}).get("activeTask")

        prefix = f"The /execute command was sent to the {alias} Lead."
        if not isinstance(final, dict) or final.get("id") != baseline_id:
            return f"{prefix}\nThe active task changed or disappeared. Check /project {alias} for current status."
        status = final.get("status")
        if not isinstance(status, str) or not status:
            return f"{prefix}\nThe active task state is unavailable. Check /project {alias} for current status."
        return f"{prefix}\n{baseline_id} is currently {status}."
    finally:
        with _IN_FLIGHT_LOCK:
            _IN_FLIGHT.discard(_lock_alias(alias))


def ask_lead(alias: str, message: str, *, registry_path: Path | None = None,
             transport: Any | None = None,
             timeout: float = LEAD_RESPONSE_TIMEOUT_SECONDS, interval: float = 0.5,
             monotonic: Callable[[], float] = time.monotonic,
             sleep: Callable[[float], None] = time.sleep,
             token_factory: Callable[[], str] = new_token,
             activation_token_factory: Callable[[], str] = new_token) -> str:
    if not isinstance(message, str) or not message.strip():
        raise BridgeError("Lead message must be nonempty")
    if (not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or
            not math.isfinite(timeout) or timeout <= 0 or
            not isinstance(interval, (int, float)) or isinstance(interval, bool) or
            not math.isfinite(interval) or interval <= 0):
        raise BridgeError("Lead timeout and intervals must be finite positive numbers")
    _reject_command(message)
    with _IN_FLIGHT_LOCK:
        if _lock_alias(alias) in _IN_FLIGHT:
            raise BridgeError(f"A Lead request is already in flight for {alias!r}")
        _IN_FLIGHT.add(_lock_alias(alias))
    try:
        transport = transport or HerdrTransport()
        activation_deadline = monotonic() + 45.0
        activated = False
        try:
            project, key, lead, coder = _resolve(alias, registry_path)
        except BridgeError as exc:
            if str(exc) != "Configured Lead identity is unavailable":
                raise
            try:
                discovered = core.resolve_project(alias, registry_path)
            except core.SanbiError as resolve_exc:
                raise BridgeError(str(resolve_exc).removeprefix("Sanbi status unavailable: ")) from resolve_exc
            if discovered.get("initialized") is not False:
                raise
            project = Path(discovered["path"])
            _activate(transport, project, activation_token_factory(), activation_deadline, monotonic, sleep, min(interval, .5))
            activated = True
            project, key, lead, coder = _resolve(alias, registry_path)
            expected, online = _runtime(transport, project, key, lead, coder, alias)
        else:
            expected, online = _runtime(transport, project, key, lead, coder, alias)
        if not online:
            if not activated:
                _activate(transport, project, activation_token_factory(), activation_deadline, monotonic, sleep, min(interval, .5))
            while True:
                expected, online = _runtime(transport, project, key, lead, coder, alias)
                if online: break
                if monotonic() >= activation_deadline: raise BridgeError("Sanbi runtime readiness timed out")
                sleep(min(interval, .5, activation_deadline - monotonic()))
        pane = expected[1]
        current = transport.get_agent(pane)
        if _validate_preflight(current, lead, alias) != expected:
            raise BridgeError("Lead identity changed during preflight")
        token = token_factory()
        if not isinstance(token, str) or not _TOKEN_RE.fullmatch(token):
            raise BridgeError("Generated sentinel token is invalid")
        baseline = transport.read(pane)
        if not isinstance(baseline, str):
            raise BridgeError("Lead read output is invalid")
        opening = f"<<H:{token}>>"
        closing = f"<</H:{token}>>"
        if opening in baseline or closing in baseline:
            raise BridgeError("Generated sentinel collides with pre-prompt baseline")
        acknowledgment = transport.prompt(pane, wrap_message(message, token))
        if not isinstance(acknowledgment, dict) or acknowledgment.get("type") != "agent_prompted":
            raise BridgeError("Lead delivery acknowledgment is invalid")
        acknowledged_agent = acknowledgment.get("agent")
        if not isinstance(acknowledged_agent, dict) or _identity(acknowledged_agent) != expected:
            raise BridgeError("Lead delivery acknowledgment identity is invalid")

        # Activation, baseline capture, and prompt submission are outside the
        # response budget. The clock starts only after successful delivery.
        deadline = monotonic() + timeout

        output = ""
        while monotonic() < deadline:
            remaining = deadline - monotonic()
            if remaining <= 0:
                break
            try:
                snapshot = transport.read(pane, timeout=remaining)
            except HerdrTimeout:
                # A terminal snapshot can transiently block while Pi is working.
                # The request-level deadline remains the completion authority.
                continue
            if not isinstance(snapshot, str):
                raise BridgeError("Lead read output is invalid")
            normalized = snapshot.replace("\r\n", "\n").replace("\r", "\n")
            # Prefer a self-contained current terminal snapshot. Growing/sliding
            # reads can repeat an opening marker across polls; treating those
            # repeated views as multiple Lead emissions would be a false
            # ambiguity. A snapshot containing the full pair is authoritative.
            if opening in normalized:
                snapshot_answer = _parse_markers(normalized, token)
                if snapshot_answer is not None:
                    if _identity(transport.get_agent(pane)) != expected:
                        raise BridgeError("Lead identity changed before answer return")
                    return snapshot_answer
            output = accumulate(output, normalized)
            accumulated_opens = output.count(opening)
            accumulated_closes = output.count(closing)
            if accumulated_opens == 0 and accumulated_closes > 0:
                raise BridgeError("Lead response markers are ambiguous")
            # Repeated sliding terminal views can duplicate partial markers in
            # the synthetic accumulator. Only parse it while it represents one
            # unambiguous candidate; a complete current snapshot above remains
            # authoritative and still rejects multiple pairs in one view.
            answer = (_parse_markers(output, token)
                      if accumulated_opens <= 1 and accumulated_closes <= 1 else None)
            if answer is not None:
                if _identity(transport.get_agent(pane)) != expected:
                    raise BridgeError("Lead identity changed before answer return")
                return answer
            remaining = deadline - monotonic()
            if remaining > 0:
                sleep(min(interval, remaining))
        raise BridgeError(_delivered_timeout(alias))
    finally:
        with _IN_FLIGHT_LOCK:
            _IN_FLIGHT.discard(_lock_alias(alias))



