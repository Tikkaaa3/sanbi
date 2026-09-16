import {
  existsSync,
  mkdirSync,
  readFileSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const TOOL_NAME = "subagent";
const STATE_PATH = join(getAgentDir(), "subagents-toggle.json");

type ToggleState = { enabled: boolean };

function readEnabled(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<ToggleState>;
    return parsed.enabled !== false;
  } catch {
    return true;
  }
}

function writeEnabled(enabled: boolean): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(
    STATE_PATH,
    `${JSON.stringify({ enabled }, null, 2)}\n`,
    "utf8",
  );
}

export default function subagentToggle(pi: ExtensionAPI) {
  // Sanbi Subagent V2 owns its project-local tool registry, dashboard, and the
  // same persistent toggle file. This legacy Sanbi glue must not register a
  // competing /subagents command in upgraded Sanbi projects.
  if (process.env.SANBI_SUBAGENT_V2 === "1" || existsSync(join(process.cwd(), ".pi", "extensions", "sanbi-subagents.ts"))) return;

  let activeContext: ExtensionContext | undefined;
  let watching = false;

  function apply(ctx: ExtensionContext, notify = false) {
    const enabled = readEnabled();
    const available = pi.getAllTools().some((tool) => tool.name === TOOL_NAME);
    const active = pi.getActiveTools();
    const isDelegatedChild = Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0;

    // Sanbi uses subagents only as leaf specialists. Never expose delegation
    // recursively inside a delegated child, even though global extensions are
    // inherited by child Pi processes.
    if (isDelegatedChild) {
      if (active.includes(TOOL_NAME)) {
        pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
      }
      return;
    }

    if (available && enabled && !active.includes(TOOL_NAME)) {
      pi.setActiveTools([...active, TOOL_NAME]);
    } else if (!enabled && active.includes(TOOL_NAME)) {
      pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
    }

    if (notify && ctx.hasUI) {
      if (!available) {
        ctx.ui.notify("Subagent tool is not available.", "warning");
      } else {
        ctx.ui.notify(`Subagents ${enabled ? "enabled" : "disabled"}.`, "info");
      }
    }
  }

  function beginWatching(ctx: ExtensionContext) {
    if (watching) return;
    if (!existsSync(STATE_PATH)) writeEnabled(true);

    watchFile(STATE_PATH, { interval: 500 }, () => {
      if (activeContext) apply(activeContext, false);
    });
    watching = true;
  }

  pi.registerCommand("subagents", {
    description:
      "Globally toggle subagent tool availability: /subagents on|off|toggle|status",
    handler: async (rawArgs, ctx) => {
      activeContext = ctx;
      const arg = rawArgs.trim().toLowerCase();
      const current = readEnabled();

      if (arg === "" || arg === "toggle") {
        writeEnabled(!current);
        apply(ctx, true);
        return;
      }

      if (["on", "enable", "enabled"].includes(arg)) {
        writeEnabled(true);
        apply(ctx, true);
        return;
      }

      if (["off", "disable", "disabled"].includes(arg)) {
        writeEnabled(false);
        apply(ctx, true);
        return;
      }

      if (arg === "status") {
        const available = pi.getAllTools().some(
          (tool) => tool.name === TOOL_NAME,
        );
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Subagents: ${readEnabled() ? "on" : "off"}${
              available ? "" : " (tool unavailable)"
            }`,
            "info",
          );
        }
        apply(ctx, false);
        return;
      }

      if (ctx.hasUI) {
        ctx.ui.notify(
          "Usage: /subagents on|off|toggle|status",
          "warning",
        );
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const isDelegatedChild = Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0;
    activeContext = ctx;
    if (!existsSync(STATE_PATH)) writeEnabled(true);
    apply(ctx, false);
    if (!isDelegatedChild) beginWatching(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    activeContext = undefined;

    if (watching) {
      unwatchFile(STATE_PATH);
      watching = false;
    }
  });
}
