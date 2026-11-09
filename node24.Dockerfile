FROM node:24-bookworm-slim AS worker

ADD --checksum=sha256:424407adbde0d2ad922cb1116bb4e70de551c6744e3d01ec72542633f5db33c2 \
    https://github.com/Azure/azure-functions-nodejs-worker/releases/download/v3.17.1/azure-functions-nodejs-worker-3.17.1.tar.gz \
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
ENV FUNCTIONS_APPLICATION_DIRECTORY=/home/site/wwwroot
ENV CHROMIUM_EXECUTABLE=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY --from=worker /opt/functions-worker/ /opt/functions-worker/
COPY --from=dependencies /app/node_modules/ ./node_modules/
COPY package.json host.json ./
COPY src/ ./src/

USER node
ENTRYPOINT ["node", "/opt/functions-worker/dist/src/nodejsWorker.js"]
