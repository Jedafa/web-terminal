FROM node:20-bookworm-slim

# node-pty requires python3/make/g++ to compile the native module
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
EXPOSE 7681

CMD ["node", "server.mjs"]
