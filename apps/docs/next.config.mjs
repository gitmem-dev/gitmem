import { createMDX } from "fumadocs-mdx/next";

const config = {
  reactStrictMode: true,
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

const withMDX = createMDX();

export default withMDX(config);
