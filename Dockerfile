# ---- build stage: compile TypeScript → plain JS ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: plain node, production deps only (no tsx/esbuild/typescript) ----
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# trim V8 young-generation heap — this is a low-allocation, mostly-idle service
ENV NODE_OPTIONS=--max-semi-space-size=4

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# session/creds/cache persist here — owned by the unprivileged runtime user
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
ENV SESSION_FILE=/data/.jup-session.json
ENV PORT=8080
EXPOSE 8080

# drop root — run as the built-in unprivileged `node` user (uid 1000)
USER node

# run the compiled service directly — one node process, no transpile at runtime
CMD ["node", "dist/service/main.js"]
