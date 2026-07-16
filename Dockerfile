FROM node:20-slim

# Instala o Chromium do sistema + libs que ele precisa para rodar headless.
# Isso evita o problema classico do Puppeteer no Railway (bibliotecas .so faltando).
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr1 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Aponta o puppeteer-core para o binario do Chromium instalado acima
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
