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

# PROD-10: o servidor não roda como root. Os arquivos acima ficam do root e só
# LEGÍVEIS pro `node` (a imagem não escreve em /app; o e-mail simulado vai pra
# /tmp). A porta 80 continua: desde o Docker 20.10 o contêiner com rede própria
# nasce com net.ipv4.ip_unprivileged_port_start=0, então usuário comum abre a
# 80. Se um dia o log do boot mostrar EACCES na 80, a saída é PORT=3000 aqui e
# a porta do serviço no EasyPanel.
USER node

# PROD-10: o Docker/EasyPanel sabe se o processo está vivo. É checagem de VIDA,
# não de prontidão: qualquer resposta HTTP de /api/saude (200 ou 503) conta
# como vivo. Um 503 quer dizer "falta configuração" ou "a fila parou" — e
# reiniciar o contêiner por isso derrubaria o site inteiro em laço, sem
# consertar nada. O diagnóstico está no corpo de /api/saude; quem olha é o
# monitor externo (UptimeRobot), não o orquestrador. Vem de 127.0.0.1, então
# não gasta freio por IP.
HEALTHCHECK --interval=30s --timeout=6s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||80)+'/api/saude',{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(0),()=>process.exit(1))"

# migração falhou → o container não sobe (melhor que servidor com meio esquema)
CMD ["sh", "-c", "node scripts/migrar.mjs && exec node .output/server/index.mjs"]
