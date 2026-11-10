FROM node:24-bookworm-slim AS worker

ADD --checksum=sha256:93fbe6f007a5eab62f28e30b3fbb93c61c53ba3b9890cc135d982a8af1e4f3ca \
    https://github.com/Azure/azure-functions-nodejs-worker/releases/download/v3.17.3/azure-functions-nodejs-worker-3.17.3.tar.gz \
    /tmp/worker.tar.gz

RUN mkdir -p /opt/functions-worker \
    && tar -xzf /tmp/worker.tar.gz -C /opt/functions-worker \
    && rm /tmp/worker.tar.gz

FROM node:24-bookworm-slim AS dependencies

ARG NPM_REGISTRY=https://pkgs.dev.azure.com/azfunc/public/_packaging/upstream-public/npm/registry/
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --registry "$NPM_REGISTRY" --no-audit --no-fund

FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        chromium-sandbox \
        fonts-dejavu-core \
        fonts-liberation \
        fonts-noto-color-emoji \
        fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/site/wwwroot
ENV CHROMIUM_EXECUTABLE=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY --from=worker /opt/functions-worker/ /opt/functions-worker/
COPY --from=dependencies /app/node_modules/ ./node_modules/
COPY package.json host.json ./
COPY src/ ./src/

USER node
ENTRYPOINT ["node", "/opt/functions-worker/dist/src/nodejsWorker.js"]
