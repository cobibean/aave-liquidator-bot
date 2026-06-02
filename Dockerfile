FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    TEST_MODE=true \
    VERBOSE_HEALTH_LOGS=false

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "bot.js"]
