# Один образ — пять процессов (design D1): команда задаётся деплоем.
# Coolify: одно приложение на процесс, один и тот же образ, разные start-команды.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: bufferutil/utf-8-validate (optional deps gramjs) нативные,
# а в slim-образе нет python3/g++. Они и не нужны — websocket-пакет gramjs
# без них прозрачно падает на pure-JS реализацию.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY db ./db
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# Порт api: по нему Coolify определяет, куда направлять домен (Traefik → контейнер)
EXPOSE 8080
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/db ./db
COPY package.json ./
# api — дефолт; воркеры переопределяют команду
CMD ["node", "--enable-source-maps", "dist/process/api.js"]
