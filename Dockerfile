FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --only=production

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm install tsx --save-dev

EXPOSE 3000

ENV PORT=3000
ENV TIMEOUT=10000

CMD ["npx", "tsx", "src/server.ts"]