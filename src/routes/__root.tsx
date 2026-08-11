import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import appCss from "~/styles.css?url";

const host = import.meta.env.VITE_PUBLIC_HOSTNAME as string | undefined;
const ogImage = host ? `https://${host}/og.jpg` : undefined;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no",
      },
      { title: "WorldClaw — Agentic 3D Open-World Generation" },
      {
        name: "description",
        content:
          "WorldClaw: coarse-to-fine agentic framework for explorable, editable 3D worlds from open-ended text.",
      },
      { property: "og:title", content: "WorldClaw" },
      {
        property: "og:description",
        content: "Agentic 3D open-world generation from open-ended text.",
      },
      ...(ogImage
        ? [
            { property: "og:image", content: ogImage },
            { property: "og:image:width", content: "1200" },
            { property: "og:image:height", content: "630" },
          ]
        : []),
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  component: RootComponent,
  notFoundComponent: () => (
    <div className="flex h-dvh items-center justify-center bg-bg text-fg">
      Page not found
    </div>
  ),
});

function RootComponent() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
