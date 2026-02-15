import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: "GitMem",
    },
    links: [
      {
        text: "Docs",
        url: "/docs",
        active: "nested-url",
      },
      {
        text: "GitHub",
        url: "https://github.com/nTEG-Labs/gitmem",
        external: true,
      },
      {
        text: "npm",
        url: "https://npmjs.com/package/gitmem-mcp",
        external: true,
      },
    ],
  };
}
