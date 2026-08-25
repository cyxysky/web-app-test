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

RUN apt-get update \
    && apt-get install -y --no-install-recommends libreoffice-nogui fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV HEADLESS_BROWSER=true
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV LIBREOFFICE_PATH=/usr/bin/libreoffice
ENV LIBREOFFICE_UNO_PROGRAM_WORKER_PATH=/app/src/server/files/libreoffice-program-worker.py
ENV APP_DATA_DIR=/app
ENV ARTIFACTS_DIR=/app/artifacts

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
