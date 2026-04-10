FROM ubuntu:24.04 AS base

ENV DEBIAN_FRONTEND=noninteractive
ENV SHELL=/bin/bash
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    git \
    gnupg \
    python3 \
    python-is-python3 \
    python3-pip \
    python3-venv \
    xz-utils \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && corepack enable \
  && corepack prepare pnpm@10.33.0 --activate \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build

COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY src ./src
RUN pnpm build \
  && pnpm prune --prod

FROM base AS runtime

COPY package.json pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN ln -sf /app/dist/cli.js /usr/local/bin/panda \
  && chmod +x /app/dist/cli.js

EXPOSE 8080

ENTRYPOINT ["panda"]
CMD ["--help"]
