FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production --ignore-scripts=false

COPY . .

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/peaceplanet.db

EXPOSE 3000

# Build: v1.0.4 — fix npm ci (no lockfile), use npm install
CMD ["node", "server.js"]
