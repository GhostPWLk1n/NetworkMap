# Образ выделенного сервера базы NetworkMap.
#
# Собирать ИЗ КОРНЯ репозитория (серверу нужны и server/, и src/ — карта каналов и
# работа с БД у приложения и сервера общие, см. src/shared/dbChannels.js):
#   docker build -f server/Dockerfile -t networkmap-server .
#
# Два этапа: в первом собирается нативный модуль better-sqlite3 (для этого нужны
# python3/make/g++), во второй попадает только результат — иначе компилятор и его
# зависимости тащились бы в рабочий образ, утраивая его размер.

# ---------- этап 1: зависимости ----------
FROM node:22-bookworm-slim AS deps

# better-sqlite3 обычно ставит готовый бинарник, но если под эту платформу его нет
# (например, arm64), собирается из исходников — тогда нужны эти пакеты
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Зависимость у сервера ровно одна — better-sqlite3 (см. server/package.json).
# electron, konva и xlsx нужны только приложению и в образ не попадают.
COPY server/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# ---------- этап 2: рабочий образ ----------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NM_DATA_DIR=/data \
    NM_PORT=47821

WORKDIR /app

# node_modules кладём в КОРЕНЬ /app, а не в /app/server: модуль src/main/db требует
# better-sqlite3, и Node ищет его, поднимаясь по папкам от себя — из /app/src путь
# ведёт в /app/node_modules, а в /app/server/node_modules он не заглянет никогда
COPY --from=deps /app/node_modules ./node_modules
COPY server/package.json ./package.json
COPY server/ ./server/
COPY src/ ./src/

# Том для базы, журнала WAL, файла-замка и резервных копий. Контейнер работает от root:
# том обычно прилетает с хоста с произвольным владельцем, и запуск от непривилегированного
# пользователя упирался бы в права на запись с невнятной ошибкой SQLITE_CANTOPEN. Сервер
# слушает только внутри вашей сети, порт наружу публиковать не нужно.
VOLUME ["/data"]
EXPOSE 47821

# Тем же /health, что смотрит docker; fetch есть в Node 22 из коробки, curl в образ не нужен
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NM_PORT||47821)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Через exec, а не через shell: иначе SIGTERM от docker stop придёт оболочке, а не Node,
# и сервер не успеет снять файл-замок — перезапущенный контейнер поднялся бы в режиме
# только чтения, считая базу занятой
CMD ["node", "server/index.js"]
