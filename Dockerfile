ARG PLAYWRIGHT_VERSION=1.59.1
ARG UBUNTU_MIRROR=http://mirrors.digitalocean.com/ubuntu

FROM ubuntu:24.04 AS base
ARG UBUNTU_MIRROR

ENV DEBIAN_FRONTEND=noninteractive
ENV SHELL=/bin/bash
WORKDIR /app

RUN set -eux; \
  apt_retry() { \
    attempts=0; \
    until "$@"; do \
      attempts=$((attempts + 1)); \
      if [ "$attempts" -ge 5 ]; then \
        return 1; \
      fi; \
      echo "apt command failed, retrying in 5s ($attempts/5)..." >&2; \
      sleep 5; \
    done; \
  }; \
  if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then \
    sed -i "s|http://archive.ubuntu.com/ubuntu|${UBUNTU_MIRROR}|g; s|http://security.ubuntu.com/ubuntu|${UBUNTU_MIRROR}|g" /etc/apt/sources.list.d/ubuntu.sources; \
  elif [ -f /etc/apt/sources.list ]; then \
    sed -i "s|http://archive.ubuntu.com/ubuntu|${UBUNTU_MIRROR}|g; s|http://security.ubuntu.com/ubuntu|${UBUNTU_MIRROR}|g" /etc/apt/sources.list; \
  fi; \
  apt_retry apt-get update; \
  apt_retry apt-get install -y --no-install-recommends \
    bash \
    bc \
    build-essential \
    ca-certificates \
    curl \
    dnsutils \
    ffmpeg \
    file \
    git \
    gnupg \
    jq \
    less \
    netcat-openbsd \
    poppler-utils \
    python3 \
    python-is-python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    sqlite3 \
    tree \
    unzip \
    wget \
    whois \
    xz-utils \
    zip; \
  mkdir -p /etc/apt/keyrings; \
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list; \
  apt_retry apt-get update; \
  apt_retry apt-get install -y --no-install-recommends nodejs; \
  corepack enable; \
  corepack prepare pnpm@10.33.0 --activate; \
  rm -rf /var/lib/apt/lists/*

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

RUN ln -sf /app/dist/app/cli.js /usr/local/bin/panda \
  && chmod +x /app/dist/app/cli.js

EXPOSE 8080

ENTRYPOINT ["panda"]
CMD ["--help"]

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS browser-runner

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN ln -sf /app/dist/app/cli.js /usr/local/bin/panda \
  && chmod +x /app/dist/app/cli.js \
  && mkdir -p /home/pwuser/.panda/browser-runner \
  && chown -R pwuser:pwuser /home/pwuser/.panda

USER pwuser

EXPOSE 8080

ENTRYPOINT ["panda"]
CMD ["browser-runner"]

FROM runtime AS final
