# syntax=docker/dockerfile:1

# ---- build: compile TypeScript -------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN pnpm build && pnpm prune --prod

# ---- runtime: Node + WeasyPrint + Chromium ---------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    REQUIRE_PDF=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# WeasyPrint from Debian brings Pango, Cairo and HarfBuzz with it; DejaVu is the report font.
# poppler-utils provides pdftotext for MAS circulars. git lets the worker clone TARGET_REPO_URL.
RUN apt-get update \
 && apt-get install -y --no-install-recommends weasyprint poppler-utils fonts-dejavu-core git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && weasyprint --version \
 && pdftotext -v

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Chromium and its system libraries, at the version the installed playwright package expects.
RUN node node_modules/playwright/cli.js install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

COPY fixtures ./fixtures
COPY demo-target-app ./demo-target-app

RUN mkdir -p reports .data && chown -R node:node /app
USER node

EXPOSE 8080
CMD ["node", "dist/web/server.js"]
