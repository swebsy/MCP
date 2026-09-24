# Runs the bridge over stdio for MCP introspection (Glama's listing check, the MCP
# Inspector, any sandboxed client). tools/list works with no pairing and no network.
#
# ponytail: one build stage, no dependency-layer split. Every dependency is a
# devDependency because esbuild bundles the whole server into dist/server.js, so
# the runtime stage copies the bundle and the manifest, nothing else.
FROM node:24-alpine AS build
WORKDIR /app
COPY . .
RUN npm install --no-audit --no-fund && npm run build

FROM node:24-alpine
WORKDIR /app
# server.ts reads ../package.json from next to dist/ for its version string —
# the same layout the npm tarball ships, so don't flatten it.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist/server.js ./dist/server.js
# Nothing can open a browser in here; the pairing tools say so rather than hanging.
ENV SWEBSY_NO_OPEN=1
ENTRYPOINT ["node", "dist/server.js"]
