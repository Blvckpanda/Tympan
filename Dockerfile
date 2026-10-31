# tympan serve — the hosted slice
#
# The image tag tracks the exact-pinned playwright version in package.json: the
# whole product promise is "pinned engine, reproducible bytes", so the container
# that runs the engine is pinned to the same release. Bump one, bump the other.
#
#   docker build -t tympan .
#   docker run --rm -p 8080:8080 -e TYMPAN_KEYS="key_live_abc:acme" tympan
#
# Health: GET /healthz (no auth). Everything else needs a key.

FROM mcr.microsoft.com/playwright:v1.63.0-jammy

# Chromium and its libraries come from the base image; nothing is downloaded at
# run time, and the engine version matches the playwright pin in package.json.
ENV NODE_ENV=production \
    TYMPAN_SERVE_CONCURRENCY=2 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Dependencies first, so a source edit does not invalidate the install layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY bin ./bin
COPY types ./types
COPY CHANGELOG.md LICENSE ./

# The Playwright image ships a non-root user; run as it. If your platform cannot
# start Chromium's sandbox inside the container, set TYMPAN_CHROMIUM to a system
# chrome or run with the runtime's own sandbox settings — do not disable the
# sandbox in the image for everyone.
USER pwuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "bin/tympan.js", "serve"]
CMD ["--port", "8080"]
