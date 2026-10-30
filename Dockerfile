FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node server.mjs ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
RUN mkdir -p /app/.qloo && chown node:node /app/.qloo
USER node
ENV HOST=0.0.0.0 PORT=4378
EXPOSE 4378
CMD ["node", "server.mjs"]
