# GitMem Clean Room Test Container
#
# Simulates a first-time user installing gitmem from a local tarball.
# No gitmem source code — only what npm delivers.
#
# Quick start (from repo root):
#   npm run build && npm pack --pack-destination testing/clean-room/
#   docker build -t gitmem-fresh testing/clean-room/
#   docker run -it --rm -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY gitmem-fresh

FROM node:20-slim

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
  && rm -rf /var/lib/apt/lists/*

# Install Claude CLI
RUN npm install -g @anthropic-ai/claude-code

# Create non-root developer user
RUN useradd -m -s /bin/bash developer
USER developer
WORKDIR /home/developer/my-project

# Init a git repo (gitmem expects one)
RUN git init && git config user.email "dev@test.local" && git config user.name "Test Dev"

# Install gitmem from tarball
COPY --chown=developer:developer gitmem-mcp-*.tgz /tmp/
RUN npm init -y && npm install /tmp/gitmem-mcp-*.tgz

# Run the fresh-install flow
RUN npx gitmem init \
 && npx gitmem check \
 && cp node_modules/gitmem-mcp/CLAUDE.md.template CLAUDE.md \
 && echo '{"mcpServers":{"gitmem":{"command":"npx","args":["-y","gitmem-mcp"]}}}' > .mcp.json \
 && npx gitmem install-hooks \
 && git add -A && git commit -m "initial setup with gitmem"

CMD ["claude", "--dangerously-skip-permissions"]
