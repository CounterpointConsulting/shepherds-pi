FROM node:20-bookworm

# System dependencies
RUN apt-get update && apt-get install -y \
    git \
    python3 python3-pip \
    postgresql-client \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install pi coding agent globally
RUN npm install -g @mariozechner/pi-coding-agent

# Verify pi is installed
RUN pi --version

# Workspace and mount points
RUN mkdir -p /workspace /persona /output /tmp
WORKDIR /workspace

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
