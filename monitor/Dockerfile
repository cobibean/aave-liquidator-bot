FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY monitor/package*.json ./
RUN npm ci --omit=dev

COPY monitor/src ./src
COPY monitor/public ./public
COPY src/chains.js ./bot-src/chains.js

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
