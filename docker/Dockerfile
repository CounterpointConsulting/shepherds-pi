FROM node:20-bookworm

# System dependencies
# jq replaces python3 for the JSON fallback in entrypoint.sh (much smaller image)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    jq \
    postgresql-client \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install pi coding agent globally
RUN npm install -g @mariozechner/pi-coding-agent

# Verify pi is installed
RUN pi --version

# Install Playwright globally + the Chromium browser and its OS dependencies.
# The web-tester persona's playwright-skill is mounted read-only and resolves
# this global install via `npm root -g` (see personas/web-tester/skills/
# playwright-skill/run.js). Browsers are installed to a shared location so the
# non-root `node` user can launch them at runtime.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g playwright@^1.57.0 \
    && npx --yes playwright@^1.57.0 install --with-deps chromium \
    && chmod -R a+rx /ms-playwright

# Make the skill skip auto-install (image already provides everything) and
# write its temp execution scripts to a writable dir.
ENV PLAYWRIGHT_SKILL_NO_INSTALL=1 \
    PLAYWRIGHT_SKILL_TMP=/tmp

# The node:20-bookworm base image ships a non-root user `node` at uid/gid
# 1000, which matches the HostConfig User in spawner.ts. We use it directly.

# Create workspace, persona, output, and secrets mount points and
# make them writable for the node user.
#   /workspace      — repo clone (writable bind from host tmp)
#   /persona        — read-only persona config bind
#   /output         — writable bind for result.json + events.jsonl
#   /run/secrets    — tmpfs bind for GIT_TOKEN and OPENROUTER_API_KEY
#   /home/node/.pi  — pi's config/cache dir
RUN mkdir -p /workspace /persona /output /run/secrets /home/node/.pi && \
    chown -R node:node /workspace /output /run/secrets /home/node

# Make /etc/gitconfig writable by agent so the entrypoint can configure
# credential.helper without needing write access to anything in /.
RUN touch /etc/gitconfig && chmod 666 /etc/gitconfig

WORKDIR /workspace

# Copy entrypoint + askpass helper
COPY entrypoint.sh /entrypoint.sh
COPY git-askpass.sh /usr/local/bin/git-askpass.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/git-askpass.sh

USER node

ENTRYPOINT ["/entrypoint.sh"]
