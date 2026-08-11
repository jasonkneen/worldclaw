import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "~/components/worldclaw/AppShell";
import { ClientOnly } from "~/components/worldclaw/ClientOnly";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function IndexPage() {
  return (
    <ClientOnly
      fallback={
        <div className="flex h-dvh w-full items-center justify-center bg-bg text-sm text-fg-muted">
          Loading WorldClaw…
        </div>
      }
    >
      <AppShell />
    </ClientOnly>
  );
}
