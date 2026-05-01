FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/peaceplanet.db

EXPOSE 3000

# Build: v1.0.3 — repair invoices + customer on POS receipts
CMD ["node", "server.js"]
