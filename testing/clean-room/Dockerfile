# GitMem Clean Room Test Container
#
# Simulates a first-time user installing gitmem from GitHub Packages.
# No gitmem source code — only what npm delivers.
#
# Build: docker compose build
# Run:   docker compose run --rm smoke
#        docker compose run --rm manual

FROM node:20-slim

# System dependencies (minimal)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
  && rm -rf /var/lib/apt/lists/*

# Create non-root developer user (simulates real dev)
RUN useradd -m -s /bin/bash developer
USER developer
WORKDIR /home/developer

# Configure npm for GitHub Packages auth (uses NPM_TOKEN at runtime)
RUN echo "@nteg-dev:registry=https://npm.pkg.github.com" > ~/.npmrc \
 && echo '//npm.pkg.github.com/:_authToken=${NPM_TOKEN}' >> ~/.npmrc

# Copy sample project (fake workspace)
COPY --chown=developer:developer sample-project/ /home/developer/my-project/

# Initialize git in the sample project (gitmem expects a git repo)
RUN cd /home/developer/my-project && git init && git add -A && \
    git -c user.email="dev@test.local" -c user.name="Test Dev" commit -m "initial"

# Copy test scripts
COPY --chown=developer:developer smoke-test.sh /home/developer/smoke-test.sh
COPY --chown=developer:developer mcp-smoke.ts /home/developer/mcp-smoke.ts

RUN chmod +x /home/developer/smoke-test.sh

WORKDIR /home/developer/my-project
