# Bilheteria Conquista Park — imagem de produção (EasyPanel).
# Duas etapas: a primeira compila o Nuxt; a segunda leva só o `.output`, as
# migrações e o `pg` do migrador. Mesma base nas duas, então o binário do
# `sharp` que o Nitro copia pro `.output` bate com o sistema que roda.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=80 \
    TZ=America/Bahia
# só o driver do Postgres pro migrador (o servidor já leva o dele no .output)
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund pg@^8.13.1
COPY --from=build /app/.output ./.output
COPY db ./db
COPY scripts/migrar.mjs ./scripts/migrar.mjs
EXPOSE 80
# migração falhou → o container não sobe (melhor que servidor com meio esquema)
CMD ["sh", "-c", "node scripts/migrar.mjs && exec node .output/server/index.mjs"]
