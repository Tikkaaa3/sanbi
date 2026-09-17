from __future__ import annotations

import inspect
import json
import logging
import re

_LOGGER = logging.getLogger(__name__)


_PROJECTS_PARAMETERS = {"type": "object", "properties": {}, "additionalProperties": False}
_STATUS_PARAMETERS = {
    "type": "object",
    "properties": {"project": {"type": "string", "description": "Exact alias returned by sanbi_projects; never a raw path, title, description, or guessed name"}},
    "required": ["project"],
    "additionalProperties": False,
}
_LEAD_PARAMETERS = {
    "type": "object",
    "properties": {
        "project": {"type": "string", "description": "Exact alias returned by sanbi_projects"},
        "message": {"type": "string", "description": "Owner's message for the configured existing Lead; preserve its language and substance without translation, enrichment, or rewritten requirements"},
    },
    "required": ["project", "message"],
    "additionalProperties": False,
}



def _core():
    try:
        from . import core
    except ImportError:
        import core
    return core


def sanbi_projects() -> str:
    return _core().projects_json()


def sanbi_project_status(project: str) -> str:
    return _core().project_status_json(project)


def _ask_lead(project: str, message: str) -> str:
    try:
        from .bridge import ask_lead
    except ImportError:
        from bridge import ask_lead
    return ask_lead(project, message)



def sanbi_ask_lead(project: str, message: str) -> str:
    try:
        return _ask_lead(project, message)
    except Exception as exc:
        try:
            from .bridge import BridgeError
        except ImportError:
            from bridge import BridgeError
        if isinstance(exc, BridgeError):
            return f"Lead request failed: {exc}"
        _LOGGER.error("Unexpected Lead bridge failure type=%s (content omitted)", type(exc).__name__)
        return "Lead request failed unexpectedly. Inspect local logs."


def _execute_project(project: str) -> str:
    try:
        from .bridge import execute_project
    except ImportError:
        from bridge import execute_project
    return execute_project(project)


def _next_project(project: str) -> str:
    try:
        from .bridge import next_project
    except ImportError:
        from bridge import next_project
    return next_project(project)


def _parse_alias_and_remainder(raw: object) -> tuple[str, str] | None:
    text = str(raw).lstrip()
    if not text:
        return None
    if text[0] in {'"', "'"}:
        quote = text[0]
        end = text.find(quote, 1)
        if end < 0 or not text[1:end]:
            return None
        if end + 1 < len(text) and not text[end + 1].isspace():
            return None
        remainder = text[end + 2:] if end + 1 < len(text) else ""
        return text[1:end], remainder
    match = re.match(r"^(\S+)(?:\s([\s\S]*))?$", text)
    return (match.group(1), match.group(2) or "") if match else None


def _single_alias(raw: object) -> str | None:
    parsed = _parse_alias_and_remainder(raw)
    return parsed[0] if parsed is not None and not parsed[1].strip() else None


async def projects_command(ctx) -> str:
    core = _core()
    return core.format_projects(json.loads(core.projects_status_json()))


async def project_command(ctx) -> str:
    raw = ctx if isinstance(ctx, str) else getattr(ctx, "args", "")
    project = _single_alias(raw)
    if project is None:
        return "Usage: /project <alias>"
    return _core().format_status(json.loads(sanbi_project_status(project)))


async def lead_command(ctx) -> str:
    raw = ctx if isinstance(ctx, str) else getattr(ctx, "args", "")
    parsed = _parse_alias_and_remainder(raw)
    if parsed is None or not parsed[1].strip():
        return "Usage: /lead <alias> <message>"
    project, message = parsed
    answer = sanbi_ask_lead(project, message)
    if answer.startswith("Lead request failed"):
        return answer
    # Hermes' native gateway owns platform-specific splitting; preserve all text.
    return f"{project} Lead:\n\n{answer}"


async def execute_command(ctx) -> str:
    raw = ctx if isinstance(ctx, str) else getattr(ctx, "args", "")
    project = _single_alias(raw)
    if project is None:
        return "Usage: /execute <project>"
    try:
        return _execute_project(project)
    except Exception as exc:
        try:
            from .bridge import BridgeError
        except ImportError:
            from bridge import BridgeError
        if isinstance(exc, BridgeError):
            if str(exc).startswith(f"Unknown project alias {project!r}"):
                return f"Unknown Sanbi project: {project}"
            return f"Execute request failed: {exc}"
        _LOGGER.error("Unexpected execute failure type=%s (content omitted)", type(exc).__name__)
        return "Execute request failed unexpectedly. Inspect local logs."


async def next_command(ctx) -> str:
    raw = ctx if isinstance(ctx, str) else getattr(ctx, "args", "")
    project = _single_alias(raw)
    if project is None:
        return "Usage: /next <project>"
    try:
        return _next_project(project)
    except Exception as exc:
        try:
            from .bridge import BridgeError
        except ImportError:
            from bridge import BridgeError
        if isinstance(exc, BridgeError):
            if str(exc).startswith(f"Unknown project alias {project!r}"):
                return f"Unknown Sanbi project: {project}"
            return f"Next request failed: {exc}"
        _LOGGER.error("Unexpected next failure type=%s (content omitted)", type(exc).__name__)
        return "Next request failed unexpectedly. Inspect local logs."


def build_to_task_preparation(owner_request: str) -> str:
    """Build the narrow conversational preparation contract for one Lead turn."""
    return (
        "Handle this as the remote /to-task workflow using the Sanbi to-task skill/process. "
        "Treat the owner request exactly as written: preserve its language and substance and "
        "Do not enrich, translate, improve, or add requirements. Do not invoke ask_user or wait "
        "for local input. If clarification is required, put that question in the final sentinel "
        "response and stop normally; starting this workflow is not final READY approval. You "
        "must not create or write a READY task, and must not make an initiative READY, until a "
        "later explicit /to-task-approve owner turn. Return the proposal and end with exactly "
        "'Create this task as READY?'. This /to-task-specific gate overrides the generic 2.6A "
        "duplicate-confirmation rule. Never invoke /execute and never contact or prompt Coder.\n\n"
        f"Owner request (preserve exactly):\n{owner_request}"
    )


def build_to_task_approval() -> str:
    """Build the narrow conversational approval contract for one Lead turn."""
    return (
        "Treat this message as explicit owner approval only for exactly one most recent clear "
        "pending proposal in the current Lead session from the remote /to-task workflow; preserve "
        "the proposal substantially and create exactly one active READY task through normal Sanbi writes. "
        "Never invoke /execute and never contact or prompt Coder. Do not invoke ask_user or wait "
        "for local input. Fail safely if the proposal is absent, missing, ambiguous, the session "
        "changed, or it is stale or invalid; do not invent or reconstruct a proposal. Return the "
        "result in the final sentinel response and stop normally."
    )


def _owner_safe_lead_request(project: str, message: str, label: str) -> str:
    try:
        return _ask_lead(project, message)
    except Exception as exc:
        try:
            from .bridge import BridgeError
        except ImportError:
            from bridge import BridgeError
        if isinstance(exc, BridgeError):
            if str(exc).startswith(f"Unknown project alias {project!r}"):
                return f"Unknown Sanbi project: {project}"
            return f"{label} request failed: {exc}"
        _LOGGER.error("Unexpected %s failure type=%s (content omitted)", label.lower(), type(exc).__name__)
        return f"{label} request failed unexpectedly. Inspect local logs."


async def to_task_command(ctx) -> str:
    raw = ctx if isinstance(ctx, str) else getattr(ctx, "args", "")
    parsed = _parse_alias_and_remainder(raw)
    if parsed is None:
        return "Usage: /to-task <project> [request]"
    project, owner_request = parsed
    return _owner_safe_lead_request(project, build_to_task_preparation(owner_request), "To-task")


async def to_task_approve_command(ctx) -> str:
    raw = ctx if isinstance(ctx, str) else getattr(ctx, "args", "")
    project = _single_alias(raw)
    if project is None:
        return "Usage: /to-task-approve <project>"
    return _owner_safe_lead_request(project, build_to_task_approval(), "To-task approval")



def enforce_fresh_sanbi_reads(**kwargs):
    """Inject a cache-safe per-turn policy; never inject or cache project state."""
    return {
        "context": (
            "Sanbi fresh-read policy for this turn: if the user's request concerns any "
            "Sanbi project, project status, task/work item completion, initiative, frontier, "
            "next work, agents, or repository state, you MUST invoke sanbi_projects as needed "
            "and sanbi_project_status during THIS turn. Never answer from chat history or an "
            "earlier turn's tool result. Use only exact registry aliases. When the owner explicitly asks "
            "to ask, tell, consult, or discuss with a project's Lead, invoke sanbi_ask_lead. Status questions "
            "must continue to use sanbi_project_status and must not automatically consult Lead. "
            "When the owner wants you to tell, ask, relay, or send something to a Sanbi Lead, act only as a messenger. "
            "Use sanbi_ask_lead with the exact project alias and preserve the owner's current request as closely as possible. "
            "Do not translate the routed request and do not change its language, including mixed-language wording. "
            "Do not rewrite it into a better prompt. Do not add your own analysis, recommendations, reviews, requirements, "
            "technical details, architecture, examples, assumptions, acceptance criteria, testing requirements, or improvements. "
            "A discussion or question must not become an instruction or authorization; an explicit instruction must not be "
            "weakened into a question or suggestion. Do not merge project status or prior context into the routed message unless "
            "the owner explicitly asks you to do so. You are not the project Lead: only identify the project alias. The Lead owns "
            "project reasoning and can inspect the repository, tasks, initiative, prior context, and current project state itself. "
            "Natural-language requests must not be deterministically routed to /to-task or /to-task-approve; only the explicit "
            "registered slash commands authorize those conversational workflows."
        )
    }


def _register_tool(ctx, name, fn, description, parameters):
    params = inspect.signature(ctx.register_tool).parameters
    if "schema" in params:
        schema = {"name": name, "description": description, "parameters": parameters}
        def handler(args, **kwargs):
            del kwargs
            required = set(parameters.get("required", []))
            if not isinstance(args, dict) or set(args) != required:
                raise ValueError(f"Invalid arguments for {name}")
            return fn(**args)
        return ctx.register_tool(name=name, toolset="sanbi_readonly", schema=schema, handler=handler,
                                 description=description)
    return ctx.register_tool(name, fn, description, parameters, toolset="sanbi_readonly")


def _register_command(ctx, name, handler, description, usage):
    params = inspect.signature(ctx.register_command).parameters
    if "args_hint" in params:
        return ctx.register_command(name=name, handler=handler, description=description,
                                    args_hint=usage.removeprefix(f"/{name}").strip())
    return ctx.register_command(name, handler, description, usage)


def register(ctx):
    _register_tool(ctx, "sanbi_projects", sanbi_projects,
                   "For every question about which Sanbi projects are currently registered, or whenever the user refers to a project by an informal name rather than a known exact alias, you MUST call this tool first. Freshly list configured aliases and canonical paths; never answer from chat memory. If exactly one alias exists, it may resolve an informal project reference; if several exist and the reference is ambiguous, ask the user to choose.", _PROJECTS_PARAMETERS)
    _register_tool(ctx, "sanbi_project_status", sanbi_project_status,
                   "For every question about a current Sanbi project, status, task, initiative, implementation, agent, repository, or frontier, you MUST call this tool. The project argument MUST be an exact alias returned by sanbi_projects; never pass a title, description, informal name, or raw path. If the user did not give a known exact alias, call sanbi_projects first; use its sole alias when exactly one exists, otherwise ask the user to choose. Freshly read authoritative state; never answer from chat memory.",
                   _STATUS_PARAMETERS)
    _register_tool(ctx, "sanbi_ask_lead", sanbi_ask_lead,
                   "Communicate only with the configured existing Sanbi Lead, and only when the owner explicitly asks to contact or ask the Lead. This is not a status tool; ordinary project/status questions must continue to use sanbi_project_status. Pass an exact registry alias. Act only as a messenger: preserve the owner's message, language, discussion-versus-action intent, and authorization strength; never translate, enrich, improve, review, or add technical requirements.",
                   _LEAD_PARAMETERS)

    ctx.register_hook("pre_llm_call", enforce_fresh_sanbi_reads)
    _register_command(ctx, "projects", projects_command, "List configured Sanbi projects.", "/projects")
    _register_command(ctx, "project", project_command, "Show one Sanbi project's status.", "/project <alias>")
    _register_command(ctx, "lead", lead_command, "Send an explicit owner message to the configured existing Lead.", "/lead <alias> <message>")
    _register_command(ctx, "execute", execute_command, "Send Sanbi's fixed /execute command to the configured Lead.", "/execute <project>")
    _register_command(ctx, "next", next_command, "Send Sanbi's fixed /next command to the configured Lead.", "/next <project>")
    _register_command(ctx, "to-task", to_task_command, "Prepare one Sanbi task proposal through the configured Lead.", "/to-task <project> [request]")
    _register_command(ctx, "to-task-approve", to_task_approve_command, "Explicitly approve the current Lead session's one pending task proposal.", "/to-task-approve <project>")


