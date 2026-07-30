# Slika za Rezora server (Meta Cloud kanal, dashboard, booking jezgro).
#
# QR agent nije dio ove slike jer traži Chromium i pokreće se odvojeno.
# Zato se preskače preuzimanje Chromiuma koje whatsapp-web.js inače povlači.

# ---------- gradnja ----------
FROM node:22-alpine AS gradnja

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Zadržavamo samo produkcijske zavisnosti za konačnu sliku.
RUN npm prune --omit=dev

# ---------- izvršavanje ----------
FROM node:22-alpine AS izvrsavanje

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# Ne radimo kao root.
RUN addgroup -S rezora && adduser -S rezora -G rezora

COPY --from=gradnja --chown=rezora:rezora /app/node_modules ./node_modules
COPY --from=gradnja --chown=rezora:rezora /app/dist ./dist
COPY --chown=rezora:rezora package.json ./
COPY --chown=rezora:rezora database ./database

USER rezora

EXPOSE 3001

# Aplikacija je "spremna" tek kad joj je baza dostupna.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
