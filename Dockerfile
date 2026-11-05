FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY vite.config.mjs ./
COPY ui/ ui/
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY package.json *.mjs ./
COPY public/ public/
COPY --from=build /app/public/ui/ ./public/ui/
RUN install -d -o node -g node -m 0700 /data \
    && install -o node -g node -m 0600 /dev/null /data/.volume
USER node
EXPOSE 8768
CMD ["node", "multi-user.mjs"]
