FROM node:24-alpine

WORKDIR /app

# install deps first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# app source
COPY tsconfig.json ./
COPY src ./src

# session persists here — mount a volume
VOLUME ["/data"]
ENV SESSION_FILE=/data/.jup-session.json
ENV PORT=8080
EXPOSE 8080

# run the TypeScript service directly via tsx
CMD ["npx", "tsx", "src/service/main.ts"]
