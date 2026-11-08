# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS worker

ADD --checksum=sha256:424407adbde0d2ad922cb1116bb4e70de551c6744e3d01ec72542633f5db33c2 \
    https://github.com/Azure/azure-functions-nodejs-worker/releases/download/v3.17.1/azure-functions-nodejs-worker-3.17.1.tar.gz \
    /tmp/worker.tar.gz

RUN mkdir -p /opt/functions-worker \
    && tar -xzf /tmp/worker.tar.gz -C /opt/functions-worker \
    && rm /tmp/worker.tar.gz

FROM node:24-bookworm-slim AS dependencies

ARG NPM_REGISTRY=https://registry.npmjs.org/
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm ci \
        --omit=dev \
        --ignore-scripts \
        --registry "$NPM_REGISTRY" \
        --replace-registry-host=always \
        --no-audit \
        --no-fund

FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        fontconfig \
        fonts-liberation \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
        fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

ENV CHROMIUM_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /home/site/wwwroot
COPY --from=worker /opt/functions-worker/ /opt/functions-worker/
COPY --from=dependencies /app/node_modules/ ./node_modules/
COPY --chown=node:node package.json host.json ./
COPY --chown=node:node src/ ./src/

USER node
ENTRYPOINT ["node", "/opt/functions-worker/dist/src/nodejsWorker.js"]
