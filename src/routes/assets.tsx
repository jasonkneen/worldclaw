import { createFileRoute } from "@tanstack/react-router";
import { AssetLibraryBrowser } from "~/components/worldclaw/AssetLibraryBrowser";

export const Route = createFileRoute("/assets")({
  head: () => ({
    meta: [
      { title: "Asset Library — WorldClaw" },
      {
        name: "description",
        content:
          "Browse WorldClaw's published 3D prototype families, authored variants, and saved render evidence.",
      },
    ],
  }),
  component: AssetLibraryPage,
});

function AssetLibraryPage() {
  return <AssetLibraryBrowser />;
}
