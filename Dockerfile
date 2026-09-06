# syntax=docker/dockerfile:1.7
ARG WEBPILOT_CAPABILITY_SOURCE=workspace
ARG ORBIT_CAPABILITY_SOURCE=${WEBPILOT_CAPABILITY_SOURCE}

FROM mcr.microsoft.com/playwright:v1.60.0-noble AS manifests
RUN --mount=type=bind,target=/source node /source/scripts/stage-workspace-manifests.mjs /source /metadata

FROM mcr.microsoft.com/playwright:v1.60.0-noble AS build

WORKDIR /app

ARG ORBIT_CAPABILITY_SOURCE
ENV WEBPILOT_CAPABILITY_SOURCE=${ORBIT_CAPABILITY_SOURCE}

COPY package*.json ./
COPY scripts/prepare-capability-install.mjs ./scripts/prepare-capability-install.mjs
COPY --from=manifests /metadata/packages ./packages
RUN if [ "$WEBPILOT_CAPABILITY_SOURCE" = "npm" ]; then node scripts/prepare-capability-install.mjs npm && npm install && cp package.json /tmp/webpilot-package.json && cp package-lock.json /tmp/webpilot-package-lock.json; else npm ci; fi

COPY . .
RUN if [ "$WEBPILOT_CAPABILITY_SOURCE" = "npm" ]; then cp /tmp/webpilot-package.json package.json && cp /tmp/webpilot-package-lock.json package-lock.json; else node scripts/prepare-capability-install.mjs workspace; fi
RUN node scripts/stage-capability-runtime.mjs "$WEBPILOT_CAPABILITY_SOURCE"
ARG WEBPILOT_BASE_PATH=
ARG ORBIT_BASE_PATH=${WEBPILOT_BASE_PATH}
ARG ORBIT_BRAND_PREFIX=
ARG ORBIT_BRAND_TEXT=Orbit
# Only public build-time settings belong in the image. Runtime values arrive via env_file / --env-file.
RUN ORBIT_BASE_PATH="$ORBIT_BASE_PATH" ORBIT_BRAND_PREFIX="$ORBIT_BRAND_PREFIX" ORBIT_BRAND_TEXT="$ORBIT_BRAND_TEXT" npm run build
RUN npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.60.0-noble AS runner

WORKDIR /app

ARG ORBIT_CAPABILITY_SOURCE
ENV WEBPILOT_CAPABILITY_SOURCE=${ORBIT_CAPABILITY_SOURCE}

ARG GLINER_MODEL=fastino/gliner2.5-multi-v1
ARG GLINER_CHINESE_NER_MODEL=uer/roberta-base-finetuned-cluener2020-chinese
ARG GLINER_PII_MODEL=LiquidAI/LFM2.5-Encoder-350M-PII-Detector

RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-nogui fonts-noto-cjk python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/.capability-runtime/sensitive-data/python/requirements.txt /opt/webpilot-sensitive-data/service/requirements.txt
RUN python3 -m venv /opt/webpilot-sensitive-data/python \
    && /opt/webpilot-sensitive-data/python/bin/python -m pip install --no-cache-dir --upgrade pip \
    && /opt/webpilot-sensitive-data/python/bin/python -m pip install --no-cache-dir -r /opt/webpilot-sensitive-data/service/requirements.txt
COPY --from=build /app/.capability-runtime/sensitive-data/python/ /opt/webpilot-sensitive-data/service/
ENV GLINER_BUNDLED_MODEL_NAME=${GLINER_MODEL}
ENV GLINER_BUNDLED_CHINESE_NER_MODEL_NAME=${GLINER_CHINESE_NER_MODEL}
ENV GLINER_BUNDLED_PII_MODEL_NAME=${GLINER_PII_MODEL}
ENV GLINER_MODEL=${GLINER_MODEL}
ENV GLINER_CHINESE_NER_MODEL=${GLINER_CHINESE_NER_MODEL}
ENV GLINER_PII_MODEL=${GLINER_PII_MODEL}
RUN /opt/webpilot-sensitive-data/python/bin/python -c "import os; from huggingface_hub import snapshot_download; snapshot_download(repo_id=os.environ['GLINER_BUNDLED_MODEL_NAME'], local_dir='/opt/webpilot-sensitive-data/models/gliner2'); snapshot_download(repo_id=os.environ['GLINER_BUNDLED_CHINESE_NER_MODEL_NAME'], local_dir='/opt/webpilot-sensitive-data/models/chinese-roberta'); snapshot_download(repo_id=os.environ['GLINER_BUNDLED_PII_MODEL_NAME'], local_dir='/opt/webpilot-sensitive-data/models/liquid-pii')"

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV HEADLESS_BROWSER=true
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV LIBREOFFICE_PATH=/usr/bin/libreoffice
ENV CAPABILITY_FILE_RUNTIME_DIR=/app/capability-runtime/file
ENV CAPABILITY_BROWSER_RUNTIME_DIR=/app/capability-runtime/browser
ENV CAPABILITY_COMPUTER_RUNTIME_DIR=/app/capability-runtime/computer
ENV LIBREOFFICE_UNO_PROGRAM_WORKER_PATH=/app/capability-runtime/file/python/libreoffice-program-worker.py
ENV APP_DATA_DIR=/app
ENV ARTIFACTS_DIR=/app/artifacts
ENV AI_SENSITIVE_DATA_FILTER_ENABLED=true
ENV AI_SENSITIVE_DATA_FILTER_FAILURE_MODE=closed
ENV GLINER_RUNTIME_MODE=local
ENV GLINER_SERVICE_URL=http://127.0.0.1:18001
ENV GLINER_PYTHON_PATH=/opt/webpilot-sensitive-data/python/bin/python
ENV GLINER_SERVICE_DIR=/opt/webpilot-sensitive-data/service
ENV GLINER_MODEL_BUNDLE_DIR=/opt/webpilot-sensitive-data/models/gliner2
ENV GLINER_CHINESE_NER_MODEL_BUNDLE_DIR=/opt/webpilot-sensitive-data/models/chinese-roberta
ENV GLINER_PII_MODEL_BUNDLE_DIR=/opt/webpilot-sensitive-data/models/liquid-pii
ENV GLINER_DEVICE=cpu
ENV GLINER_BATCH_SIZE=8

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/electron/product.json /app/electron/product-brand.js ./electron/
COPY --from=build /app/server ./server
COPY --from=build /app/.capability-runtime/file ./capability-runtime/file
COPY --from=build /app/.capability-runtime/browser ./capability-runtime/browser
COPY --from=build /app/.capability-runtime/computer ./capability-runtime/computer

RUN find ./server -type f -name '*.test.js' -delete \
    && mkdir -p .data artifacts

EXPOSE 3000

CMD ["node", "server/webpilot-server.js"]


# docker build --platform linux/amd64 -t orbit:20260806 .
