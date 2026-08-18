import { useEffect, useRef } from "react";
import { useWorldClaw } from "~/lib/worldclaw/store";
import type { AgentLogEntry } from "~/lib/worldclaw/types";
import { cn } from "~/lib/utils";

function levelClass(level: AgentLogEntry["level"]) {
  switch (level) {
    case "success":
      return "text-success";
    case "warn":
      return "text-warn";
    case "detail":
      return "text-fg-subtle";
    default:
      return "text-fg-muted";
  }
}

export function AgentConsole() {
  const logs = useWorldClaw((s) => s.logs);
  const running = useWorldClaw((s) => s.running);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium tracking-wide text-fg-muted uppercase">
          Agent console
        </span>
        {running && (
          <span className="flex items-center gap-1.5 text-[11px] text-info">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-info" />
            Running
          </span>
        )}
      </div>
      <div className="scrollbar-thin min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
        {logs.length === 0 && (
          <p className="text-fg-subtle">
            Waiting for a prompt. Agents will log intent analysis, terrain
            planning, regional generation, and refinement here.
          </p>
        )}
        {logs.map((log) => (
          <div key={log.id} className="flex gap-2">
            <span className="shrink-0 text-fg-subtle">
              [{log.agent.replace(/Agent$/, "")}]
            </span>
            <span className={cn(levelClass(log.level))}>{log.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
