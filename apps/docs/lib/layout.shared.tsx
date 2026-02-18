import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <img
            src="/docs/logo.svg"
            alt=""
            className="nav-logo"
            style={{ width: 24, height: 24 }}
          />
          GitMem
        </>
      ),
      url: "/docs",
    },
    links: [
      {
        text: "Docs",
        url: "/docs",
        active: "nested-url",
      },
      {
        text: "Website",
        url: "https://gitmem.ai",
        external: true,
      },
      {
        text: "GitHub",
        url: "https://github.com/gitmem-dev/gitmem",
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
