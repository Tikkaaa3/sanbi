"""Read-only Sanbi registry and durable project-state reader."""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Callable

import yaml

_ALIAS_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_TASK_ID_RE = re.compile(r"^T-([0-9]{3,})$")
_WORK_HEADING_RE = re.compile(r"^###\s+(W[0-9]+)\s+—\s+(.+?)\s*$")
_META_RE = re.compile(r"^\*\*(Status|Blocked by|Sanbi task|Outcome|Verification):\*\*\s*(.*?)\s*(?:  )?$")
_TASK_STATUSES = {"DRAFT", "READY", "CODING", "BLOCKED", "REVIEW", "DONE"}
_INITIATIVE_STATUSES = {"DRAFT", "ACTIVE", "PAUSED", "DONE"}
_WORK_STATUSES = {"PLANNED", "READY", "DONE", "DROPPED"}


def _hermes_home() -> Path:
    configured = os.environ.get("HERMES_HOME", "").strip()
    if configured:
        return Path(configured)
    try:
        from hermes_constants import get_hermes_home
        return Path(get_hermes_home())
    except (ImportError, OSError, RuntimeError):
        local_appdata = os.environ.get("LOCALAPPDATA", "").strip()
        base = Path(local_appdata) if local_appdata else Path.home() / "AppData" / "Local"
        return base / "hermes"


def default_registry_path() -> Path:
    return _hermes_home() / "sanbi" / "projects.json"


class SanbiError(ValueError):
    pass


class _StrictSafeLoader(yaml.SafeLoader):
    pass


def _strict_mapping(loader, node, deep=False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.constructor.ConstructorError("mapping", node.start_mark, f"duplicate key: {key}", key_node.start_mark)
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


_StrictSafeLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _strict_mapping)


def _error(message: str) -> SanbiError:
    return SanbiError(f"Sanbi status unavailable: {message}")


def load_registry(path: Path | None = None) -> list[dict[str, str]]:
    path = Path(path) if path is not None else default_registry_path()
    if not path.is_file():
        raise _error(f"registry does not exist: {path}")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise _error("registry is not valid JSON") from exc
    if not isinstance(raw, dict):
        raise _error("registry root must be an object")
    unknown_root = set(raw) - {"projects"}
    if unknown_root:
        raise _error(f"unknown registry field(s): {', '.join(sorted(unknown_root))}")
    projects = raw.get("projects")
    if not isinstance(projects, dict):
        raise _error("registry projects must be an object")
    result: list[dict[str, str]] = []
    canonical: dict[str, str] = {}
    for alias in sorted(projects, key=lambda value: str(value)):
        if not isinstance(alias, str) or not _ALIAS_RE.fullmatch(alias):
            raise _error(f"unsafe project alias: {alias!r}")
        entry = projects[alias]
        if isinstance(entry, dict):
            unknown_entry = set(entry) - {"path"}
            if unknown_entry:
                raise _error(f"project {alias!r} has unknown field(s): {', '.join(sorted(unknown_entry))}")
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not entry["path"].strip():
            raise _error(f"project {alias!r} path must be a nonempty string")
        project_path = Path(entry["path"])
        if not project_path.is_absolute():
            raise _error(f"project {alias!r} path must be absolute")
        if not project_path.is_dir():
            raise _error(f"project {alias!r} path is not an existing directory")
        if not (project_path / ".agent").is_dir():
            raise _error(f"project {alias!r} path has no .agent directory")
        resolved = str(project_path.resolve()).casefold() if os.name == "nt" else str(project_path.resolve())
        if resolved in canonical:
            raise _error(f"canonical duplicate project paths for {canonical[resolved]!r} and {alias!r}")
        canonical[resolved] = alias
        result.append({"alias": alias, "path": str(project_path.resolve())})
    return result


def _frontmatter(path: Path, kind: str) -> tuple[dict[str, Any], str]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise _error(f"cannot read {kind} {path.name}") from exc
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        raise _error(f"malformed {kind} frontmatter in {path.name}")
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration as exc:
        raise _error(f"malformed {kind} frontmatter in {path.name}") from exc
    try:
        data = yaml.load("\n".join(lines[1:end]), Loader=_StrictSafeLoader)
    except yaml.YAMLError as exc:
        raise _error(f"malformed {kind} frontmatter in {path.name}") from exc
    if not isinstance(data, dict):
        raise _error(f"malformed {kind} frontmatter in {path.name}")
    return data, "\n".join(lines[end + 1 :])


def _nonempty_string(data: dict[str, Any], field: str, kind: str, filename: str) -> str:
    value = data.get(field)
    if not isinstance(value, str) or not value.strip():
        raise _error(f"{kind} {filename} required field {field!r} must be a nonempty string")
    return value.strip()


def _read_tasks(agent: Path) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    seen: set[str] = set()
    directory = agent / "tasks"
    for path in sorted(directory.glob("*.md"), key=lambda p: p.name.casefold()) if directory.is_dir() else []:
        data, _ = _frontmatter(path, "task")
        values = {field: _nonempty_string(data, field, "task", path.name)
                  for field in ("id", "title", "status", "initiative", "work_item")}
        task_id = values["id"]
        if not _TASK_ID_RE.fullmatch(task_id):
            raise _error(f"task {path.name} id must match T-NNN")
        if task_id in seen:
            raise _error(f"duplicate task id {task_id}")
        seen.add(task_id)
        if values["status"] not in _TASK_STATUSES:
            raise _error(f"invalid task status {values['status']!r} in {path.name}")
        if type(data.get("active")) is not bool:
            raise _error(f"task {path.name} active must be a strict boolean")
        tasks.append({**values, "active": data["active"]})
    active = [task for task in tasks if task["active"]]
    if len(active) > 1:
        raise _error("more than one active task")
    return tasks


def _read_initiatives(agent: Path) -> list[tuple[dict[str, str], str]]:
    initiatives: list[tuple[dict[str, str], str]] = []
    seen: set[str] = set()
    directory = agent / "initiatives"
    for path in sorted(directory.glob("*.md"), key=lambda p: p.name.casefold()) if directory.is_dir() else []:
        data, body = _frontmatter(path, "initiative")
        values = {field: _nonempty_string(data, field, "initiative", path.name)
                  for field in ("id", "title", "status")}
        if values["id"] in seen:
            raise _error(f"duplicate initiative id {values['id']}")
        seen.add(values["id"])
        if values["status"] not in _INITIATIVE_STATUSES:
            raise _error(f"invalid initiative status {values['status']!r} in {path.name}")
        initiatives.append((values, body))
    if sum(values["status"] == "ACTIVE" for values, _ in initiatives) > 1:
        raise _error("more than one active initiative")
    return initiatives


def _parse_work_map(body: str, task_ids: set[str]) -> tuple[list[dict[str, Any]], list[str]]:
    matches = list(re.finditer(r"^## Work Map\s*$", body, re.MULTILINE))
    if not matches:
        raise _error("active initiative is missing Work Map section")
    if len(matches) > 1:
        raise _error("active initiative has duplicate Work Map sections")
    start = matches[0].end()
    next_section = re.search(r"^##\s+", body[start:], re.MULTILINE)
    work_map = body[start:start + next_section.start()] if next_section else body[start:]
    sections: list[tuple[str, str, list[str]]] = []
    current: tuple[str, str, list[str]] | None = None
    for line in work_map.splitlines():
        match = _WORK_HEADING_RE.match(line)
        if match:
            if current:
                sections.append(current)
            current = (match.group(1), match.group(2).strip(), [])
        elif re.match(r"^###\s+W\S*", line):
            raise _error(f"malformed work item heading: {line.strip()}")
        elif line.startswith("###"):
            raise _error(f"malformed work item heading: {line.strip()}")
        elif current is None and re.match(r"^\*\*[^*]+:\*\*", line.strip()):
            raise _error(f"unknown work metadata outside a work item: {line.strip()}")
        elif current is None and line.strip().startswith("**"):
            raise _error(f"malformed work metadata outside a work item: {line.strip()}")
        elif current:
            current[2].append(line)
    if current:
        sections.append(current)
    if not sections:
        raise _error("Work Map must contain at least one well-formed W item")
    items: list[dict[str, Any]] = []
    ids: set[str] = set()
    warnings: list[str] = []
    for work_id, title, lines in sections:
        if work_id in ids:
            raise _error(f"duplicate work id {work_id}")
        ids.add(work_id)
        metadata: dict[str, str] = {}
        for line in lines:
            stripped = line.strip()
            match = _META_RE.fullmatch(stripped)
            if match:
                key = match.group(1)
                if key in metadata:
                    raise _error(f"duplicate work metadata {key!r} for {work_id}")
                metadata[key] = match.group(2).strip()
            elif re.match(r"^\*\*[^*]+:\*\*", stripped):
                raise _error(f"unknown work metadata for {work_id}: {stripped}")
            elif stripped.startswith("**"):
                raise _error(f"malformed work metadata for {work_id}: {stripped}")
        status = metadata.get("Status")
        if status not in _WORK_STATUSES:
            raise _error(f"invalid or missing work status for {work_id}")
        blocked_raw = metadata.get("Blocked by")
        if blocked_raw is None:
            raise _error(f"missing Blocked by for {work_id}")
        blockers = [] if blocked_raw.casefold() == "none" else [x.strip() for x in blocked_raw.split(",") if x.strip()]
        task = metadata.get("Sanbi task") or None
        if status == "READY" and not task:
            raise _error(f"READY work item {work_id} requires a Sanbi Task reference")
        if task and (not _TASK_ID_RE.fullmatch(task) or task not in task_ids):
            raise _error(f"invalid or unknown Sanbi Task reference for {work_id}: {task}")
        if status == "DONE" and not task:
            warnings.append(f"{work_id} is DONE without a Sanbi Task linkage")
        items.append({"id": work_id, "title": title, "status": status, "blockedBy": blockers, "sanbiTask": task})
    by_id = {item["id"]: item for item in items}
    for item in items:
        unknown = [blocker for blocker in item["blockedBy"] if blocker not in by_id]
        if unknown:
            raise _error(f"unknown blocker(s) for {item['id']}: {', '.join(unknown)}")
    return items, warnings


def _project_identity(project: Path, alias: str) -> dict[str, Any]:
    path = project / ".agent" / "project.md"
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        text = ""
    def bold(name: str) -> str | None:
        match = re.search(rf"^\*\*{re.escape(name)}:\*\*\s*(.+?)\s*$", text, re.MULTILINE | re.IGNORECASE)
        return match.group(1).strip() if match else None
    technology: list[str] = []
    section = re.search(r"^## Current Technology\s*$([\s\S]*?)(?=^##\s|\Z)", text, re.MULTILINE | re.IGNORECASE)
    if section:
        technology = [m.group(1).strip() for m in re.finditer(r"^-\s+(.+?)\s*$", section.group(1), re.MULTILINE)]
    name = bold("Name")
    return {
        "alias": alias,
        "displayName": alias if not name or name.casefold() == "not established" else name,
        "purpose": bold("Purpose") or "Not established",
        "currentTechnology": technology,
    }


def _authoritative_vcs(project: Path) -> str:
    try:
        text = (project / ".agent" / "project.md").read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return "unknown"
    match = re.search(r"^\*\*VCS:\*\*\s*(.+?)\s*$", text, re.MULTILINE | re.IGNORECASE)
    return match.group(1).strip() if match and match.group(1).strip() else "unknown"


def _herdr_snapshot() -> dict[str, Any]:
    kwargs: dict[str, Any] = {"capture_output": True, "text": True, "timeout": 2, "check": True}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    completed = subprocess.run(["herdr", "api", "snapshot"], **kwargs)
    payload = json.loads(completed.stdout)
    snapshot = payload.get("result", {}).get("snapshot")
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("agents"), list):
        raise ValueError("unreliable Herdr snapshot")
    return snapshot


def runtime_status(project: Path, snapshot_reader: Callable[[], dict[str, Any]] = _herdr_snapshot) -> dict[str, Any]:
    ids: dict[str, str | None] = {"lead": None, "coder": None}
    try:
        config = json.loads((project / ".agent" / "config.json").read_text(encoding="utf-8"))
        herdr = config.get("herdr", {}) if isinstance(config, dict) else {}
        if isinstance(herdr, dict):
            ids = {"lead": herdr.get("leadAgent") if isinstance(herdr.get("leadAgent"), str) else None,
                   "coder": herdr.get("coderAgent") if isinstance(herdr.get("coderAgent"), str) else None}
    except (OSError, UnicodeError, json.JSONDecodeError):
        pass
    try:
        snapshot = snapshot_reader()
        agents = snapshot.get("agents")
        if not isinstance(agents, list):
            raise ValueError("agents missing")
        online = {value for agent in agents if isinstance(agent, dict)
                  for key in ("agent_id", "id") for value in [agent.get(key)] if isinstance(value, str)}
        return {role: {"agentId": agent_id, "status": "online" if agent_id in online else "offline"}
                for role, agent_id in ids.items()}
    except Exception:
        return {role: {"agentId": agent_id, "status": "unavailable"} for role, agent_id in ids.items()}


def read_project_status(alias: str, registry_path: Path | None = None,
                        runtime_reader: Callable[[Path], dict[str, Any]] = runtime_status) -> dict[str, Any]:
    registered = {entry["alias"]: entry for entry in load_registry(registry_path)}
    if not isinstance(alias, str) or not _ALIAS_RE.fullmatch(alias) or alias not in registered:
        choices = ", ".join(registered) or "none"
        raise _error(f"Unknown project alias {alias!r}; raw paths are not accepted; registered aliases: {choices}")
    project = Path(registered[alias]["path"])
    agent = project / ".agent"
    tasks = _read_tasks(agent)
    initiatives = _read_initiatives(agent)
    active_task = next((task for task in tasks if task["active"]), None)
    completed = [task for task in tasks if task["status"] == "DONE"]
    last_completed = max(completed, key=lambda task: int(_TASK_ID_RE.fullmatch(task["id"]).group(1))) if completed else None
    active_pair = next(((values, body) for values, body in initiatives if values["status"] == "ACTIVE"), None)
    work_items: list[dict[str, Any]] = []
    warnings: list[str] = []
    active_initiative = None
    if active_pair:
        active_initiative, body = active_pair
        work_items, warnings = _parse_work_map(body, {task["id"] for task in tasks})
    states = {item["id"]: item["status"] for item in work_items}
    frontier = [item for item in work_items if item["status"] == "PLANNED"
                and all(states[blocker] == "DONE" for blocker in item["blockedBy"])]
    return {
        "project": _project_identity(project, alias),
        "workflow": {
            "activeTask": active_task,
            "lastCompletedTask": last_completed,
            "activeInitiative": active_initiative,
            "workItems": work_items,
            "frontier": frontier,
        },
        "runtime": runtime_reader(project),
        "repository": {"path": str(project), "vcs": _authoritative_vcs(project)},
        "warnings": warnings,
    }


def projects_json(registry_path: Path | None = None) -> str:
    try:
        return json.dumps({"projects": load_registry(registry_path)}, ensure_ascii=False, sort_keys=True)
    except SanbiError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False, sort_keys=True)


def project_status_json(project: str, registry_path: Path | None = None) -> str:
    try:
        return json.dumps(read_project_status(project, registry_path), ensure_ascii=False, sort_keys=True)
    except SanbiError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False, sort_keys=True)


def read_projects_status(
    registry_path: Path | None = None,
    status_reader: Callable[..., dict[str, Any]] | None = None,
    runtime_reader: Callable[[Path], dict[str, Any]] = runtime_status,
) -> dict[str, Any]:
    registry_path = Path(registry_path) if registry_path is not None else default_registry_path()
    status_reader = status_reader or read_project_status
    projects = []
    for entry in load_registry(registry_path):
        status = status_reader(entry["alias"], registry_path, runtime_reader)
        projects.append({"alias": entry["alias"], "path": entry["path"], "status": status})
    return {"projects": projects}


def projects_status_json(registry_path: Path | None = None) -> str:
    try:
        return json.dumps(read_projects_status(registry_path), ensure_ascii=False, sort_keys=True)
    except SanbiError as exc:
        return json.dumps({"error": str(exc)}, ensure_ascii=False, sort_keys=True)


def format_projects(payload: dict[str, Any]) -> str:
    if payload.get("error"):
        return str(payload["error"])
    projects = payload.get("projects", [])
    if not projects:
        return "Projects: none"
    lines = ["Projects:"]
    for item in projects:
        workflow = item["status"]["workflow"]
        initiative = workflow.get("activeInitiative")
        active = workflow.get("activeTask")
        frontier = workflow.get("frontier", [])
        initiative_text = (f"Initiative {initiative['status']}: {initiative['id']} — {initiative['title']}"
                           if initiative else "Initiative: none")
        active_text = (f"Active task: {active['id']} — {active['title']} [{active['status']}]"
                       if active else "No active implementation task")
        frontier_text = ", ".join(work["title"] for work in frontier) or "none"
        lines.extend((f"- {item['alias']} — {initiative_text}", f"  {active_text}",
                      f"  Frontier: {frontier_text}"))
    return "\n".join(lines)


def format_status(payload: dict[str, Any]) -> str:
    if payload.get("error"):
        return str(payload["error"])
    project = payload["project"]
    workflow = payload["workflow"]
    active = workflow.get("activeTask")
    completed = workflow.get("lastCompletedTask")
    initiative = workflow.get("activeInitiative")
    frontier = workflow.get("frontier", [])
    runtime = payload.get("runtime", {})
    repository = payload["repository"]
    lines = [project["displayName"]]
    lines.append(f"Initiative: {initiative['id']} — {initiative['title']} [{initiative['status']}]" if initiative else "Initiative: none")
    lines.extend((
        "Implementation:",
        f"- Active: {active['id']} — {active['title']} [{active['status']}]" if active else "- Active: no active task",
        f"- Last completed: {completed['id']} — {completed['title']} [{completed['status']}]" if completed else "- Last completed: none",
    ))
    if frontier:
        lines.append("Frontier:")
        lines.extend(f"- {item['id']} — {item['title']}" for item in frontier)
    else:
        lines.append("Frontier: none")
    lines.extend((
        "Agents:",
        f"- Lead: {runtime.get('lead', {}).get('status', 'unavailable')}",
        f"- Coder: {runtime.get('coder', {}).get('status', 'unavailable')}",
        "Repository:",
        f"- Path: {repository['path']}",
        f"- VCS: {repository['vcs']}",
    ))
    warnings = payload.get("warnings", [])
    if warnings:
        lines.append("Warnings:")
        lines.extend(f"- {warning}" for warning in warnings)
    else:
        lines.append("Warnings: none")
    return "\n".join(lines)
