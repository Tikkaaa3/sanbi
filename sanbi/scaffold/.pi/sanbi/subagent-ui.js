const MAX_LABEL = 180;

function text(value, max = MAX_LABEL) {
  const compact = String(value ?? "").replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function webHost(value) {
  try {
    const url = new URL(String(value));
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch { return text(value); }
}

export function semanticTool(toolName, args = {}) {
  const tool = String(toolName || "tool");
  switch (tool) {
    case "read": return { verb: "READ", target: text(args.path ?? args.file) };
    case "grep": return { verb: "GREP", target: text(`${args.path ? `${args.path} · ` : ""}${args.pattern ?? args.query ?? ""}`) };
    case "find": {
      const root = args.path && args.path !== "." ? `${String(args.path).replace(/[\\/]$/, "")}/` : "";
      return { verb: "FIND", target: text(`${root}${args.pattern ?? "*"}`) };
    }
    case "ls": return { verb: "LIST", target: text(args.path ?? ".") };
    case "bash": return { verb: "RUN", target: text(String(args.command ?? "").split(/\r?\n/)[0]) };
    case "web_search": return { verb: "SEARCH", target: text(args.query ?? first(args.queries) ?? "web") };
    case "source_check": return { verb: "CHECK", target: text(args.claim ?? first(args.queries) ?? "source") };
    case "fetch_content": return { verb: "FETCH", target: text(webHost(args.url ?? first(args.urls) ?? "content")) };
    case "get_search_content": return { verb: "EXTRACT", target: text(args.url ? webHost(args.url) : first(args.findText) ?? args.responseId ?? "search result") };
    default: {
      const useful = args.path ?? args.file ?? args.query ?? args.command ?? args.url ?? args.id ?? "";
      return { verb: tool.replaceAll("_", " ").toUpperCase(), target: text(useful) };
    }
  }
}

export function compactToolError(value) {
  const raw = typeof value === "string" ? value : value?.message ?? value?.error ?? value?.content?.[0]?.text ?? "tool failed";
  const lines = String(raw).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = lines.find((line) => !/^(usage:|options:|commands:|git .*usage|\s*-\w)/i.test(line)) ?? lines[0] ?? "tool failed";
  return text(useful, 140);
}

export function createInspectReadModel(prompt = "") {
  return { prompt, nextId: 1, activities: [], latestText: "", liveText: "", errorCount: 0 };
}

function eventId(event) {
  return event.toolCallId ?? event.toolCall?.id ?? event.callId ?? event.id;
}

export function observeInspectEvent(model, event) {
  if (event?.type === "tool_execution_start") {
    const semantic = semanticTool(event.toolName, event.args);
    model.activities.push({ id: eventId(event) ?? `activity-${model.nextId++}`, tool: event.toolName, ...semantic, status: "running" });
  } else if (event?.type === "tool_execution_end") {
    const id = eventId(event);
    const activity = [...model.activities].reverse().find((item) => item.status === "running" && (id ? item.id === id : item.tool === event.toolName));
    if (activity) {
      activity.status = event.isError ? "error" : "done";
      if (event.isError) { activity.error = compactToolError(event.result ?? event.error); model.errorCount += 1; }
    }
  } else if (event?.type === "assistant_text") {
    model.latestText = text(event.text, 1_000);
    model.liveText = "";
  } else if (event?.type === "assistant_text_delta") {
    model.liveText += String(event.delta ?? "");
  } else if (event?.type === "error") {
    model.latestText = compactToolError(event.error);
    model.errorCount += 1;
  }
  if (model.activities.length > 200) model.activities.splice(0, model.activities.length - 200);
  return model;
}

export function currentActivity(model) {
  const active = [...model.activities].reverse().find((item) => item.status === "running");
  if (active) return `${active.verb} ${active.target}`.trim();
  const live = text(model.liveText, 160);
  return live || "Reasoning...";
}

export function latestVisibleText(model, finalText = "") {
  return text(finalText || model.liveText || model.latestText, 280);
}

export function activityRows(model, limit = 12) {
  return model.activities.slice(-limit).map((item) => ({
    symbol: item.status === "running" ? "●" : item.status === "error" ? "✗" : "✓",
    text: `${item.verb}${item.target ? `    ${item.target}` : ""}${item.error ? ` — ${item.error}` : ""}`,
    status: item.status,
  }));
}

export function activityCounts(model) {
  const reads = model.activities.filter((item) => item.tool === "read").length;
  const searches = model.activities.filter((item) => ["grep", "find", "web_search", "source_check"].includes(item.tool)).length;
  return `${reads} file${reads === 1 ? "" : "s"} read · ${searches} search${searches === 1 ? "" : "es"} · ${model.errorCount} error${model.errorCount === 1 ? "" : "s"}`;
}
