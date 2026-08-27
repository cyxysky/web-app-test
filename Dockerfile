FROM mcr.microsoft.com/playwright:v1.60.0-noble AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
ARG WEBPILOT_BASE_PATH
# The image includes .env. An explicitly supplied build argument can override
# its base path, while an omitted argument leaves Next.js to load .env.
RUN if [ -n "$WEBPILOT_BASE_PATH" ]; then WEBPILOT_BASE_PATH="$WEBPILOT_BASE_PATH" npm run build; else npm run build; fi
RUN npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.60.0-noble AS runner

WORKDIR /app

ARG GLINER_MODEL=fastino/gliner2.5-multi-v1
ARG GLINER_CHINESE_NER_MODEL=uer/roberta-base-finetuned-cluener2020-chinese
ARG GLINER_PII_MODEL=LiquidAI/LFM2.5-Encoder-350M-PII-Detector

RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-nogui fonts-noto-cjk python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY services/gliner/requirements.txt /opt/webpilot-gliner/service/requirements.txt
RUN python3 -m venv /opt/webpilot-gliner/python \
    && /opt/webpilot-gliner/python/bin/python -m pip install --no-cache-dir --upgrade pip \
    && /opt/webpilot-gliner/python/bin/python -m pip install --no-cache-dir -r /opt/webpilot-gliner/service/requirements.txt
COPY services/gliner/app.py /opt/webpilot-gliner/service/app.py
COPY services/gliner/candidate_resolution.py /opt/webpilot-gliner/service/candidate_resolution.py
COPY services/gliner/entity_boundaries.py /opt/webpilot-gliner/service/entity_boundaries.py
COPY services/gliner/deterministic_spans.py /opt/webpilot-gliner/service/deterministic_spans.py
ENV GLINER_BUNDLED_MODEL_NAME=${GLINER_MODEL}
ENV GLINER_BUNDLED_CHINESE_NER_MODEL_NAME=${GLINER_CHINESE_NER_MODEL}
ENV GLINER_BUNDLED_PII_MODEL_NAME=${GLINER_PII_MODEL}
ENV GLINER_MODEL=${GLINER_MODEL}
ENV GLINER_CHINESE_NER_MODEL=${GLINER_CHINESE_NER_MODEL}
ENV GLINER_PII_MODEL=${GLINER_PII_MODEL}
RUN /opt/webpilot-gliner/python/bin/python -c "import os; from huggingface_hub import snapshot_download; snapshot_download(repo_id=os.environ['GLINER_BUNDLED_MODEL_NAME'], local_dir='/opt/webpilot-gliner/models/gliner2'); snapshot_download(repo_id=os.environ['GLINER_BUNDLED_CHINESE_NER_MODEL_NAME'], local_dir='/opt/webpilot-gliner/models/chinese-roberta'); snapshot_download(repo_id=os.environ['GLINER_BUNDLED_PII_MODEL_NAME'], local_dir='/opt/webpilot-gliner/models/liquid-pii')"

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV HEADLESS_BROWSER=true
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV LIBREOFFICE_PATH=/usr/bin/libreoffice
ENV LIBREOFFICE_UNO_PROGRAM_WORKER_PATH=/app/src/server/files/libreoffice-program-worker.py
ENV APP_DATA_DIR=/app
ENV ARTIFACTS_DIR=/app/artifacts
ENV AI_SENSITIVE_DATA_FILTER_ENABLED=true
ENV AI_SENSITIVE_DATA_FILTER_FAILURE_MODE=closed
ENV GLINER_RUNTIME_MODE=local
ENV GLINER_SERVICE_URL=http://127.0.0.1:18001
ENV GLINER_PYTHON_PATH=/opt/webpilot-gliner/python/bin/python
ENV GLINER_SERVICE_DIR=/opt/webpilot-gliner/service
ENV GLINER_MODEL_BUNDLE_DIR=/opt/webpilot-gliner/models/gliner2
ENV GLINER_CHINESE_NER_MODEL_BUNDLE_DIR=/opt/webpilot-gliner/models/chinese-roberta
ENV GLINER_PII_MODEL_BUNDLE_DIR=/opt/webpilot-gliner/models/liquid-pii
ENV GLINER_DEVICE=cpu
ENV GLINER_BATCH_SIZE=8

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/.env ./.env
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/server ./server
COPY src/server/files/libreoffice-program-worker.py ./src/server/files/libreoffice-program-worker.py

RUN find ./server -type f -name '*.test.js' -delete \
    && mkdir -p .data artifacts

EXPOSE 3000

CMD ["node", "server/webpilot-server.js"]


# docker build --platform linux/amd64 -t webpilot-qa:20260806 .
