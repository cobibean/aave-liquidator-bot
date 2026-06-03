FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    TEST_MODE=true \
    VERBOSE_HEALTH_LOGS=false

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Cap V8's old-space so a runaway sweep fails loudly/recoverably instead of
# silently bloating the host. The streaming HF sweep peaks ~130 MB even at
# Base's ~210k borrowers, so 1536 MB is generous headroom on the 4 GB droplet
# while leaving room for the OS + Docker. Override with NODE_OPTIONS if needed.
CMD ["node", "--max-old-space-size=1536", "bot.js"]
