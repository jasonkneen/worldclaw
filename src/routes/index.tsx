import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { ClientOnly } from "~/components/worldclaw/ClientOnly";

const AppShell = lazy(() =>
  import("~/components/worldclaw/AppShell").then((module) => ({
    default: module.AppShell,
  })),
);

function LoadingWorld() {
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-bg text-sm text-fg-muted">
      Loading WorldClaw…
    </div>
  );
}

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function IndexPage() {
  return (
    <ClientOnly
      fallback={<LoadingWorld />}
    >
      <Suspense fallback={<LoadingWorld />}>
        <AppShell />
      </Suspense>
    </ClientOnly>
  );
}
