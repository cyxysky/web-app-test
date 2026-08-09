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

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV HEADLESS_BROWSER=true
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV APP_DATA_DIR=/app
ENV ARTIFACTS_DIR=/app/artifacts

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/.env ./.env
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/server/webpilot-server.js /app/server/webpilot-identity.js ./server/

RUN mkdir -p .data artifacts

EXPOSE 3000

CMD ["node", "server/webpilot-server.js"]


# docker build --platform linux/amd64 -t webpilot-qa:20260806 .
