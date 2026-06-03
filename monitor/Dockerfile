FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV MONITOR_HOST=0.0.0.0
ENV MONITOR_PORT=8787

COPY monitor/package*.json ./
RUN npm ci --omit=dev

COPY monitor/src ./src
COPY monitor/public ./public

USER node
EXPOSE 8787
CMD ["node", "src/server.js"]
