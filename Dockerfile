FROM mcr.microsoft.com/playwright:v1.60.0-noble AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
ARG WEBPILOT_BASE_PATH
ENV WEBPILOT_BASE_PATH=${WEBPILOT_BASE_PATH}
RUN npm run build
RUN npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.60.0-noble AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV HEADLESS_BROWSER=true
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/next.config.ts ./next.config.ts

RUN mkdir -p .data artifacts

EXPOSE 3000

CMD ["npm", "run", "start"]
