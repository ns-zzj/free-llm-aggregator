# 目标环境：Debian 12（bookworm）+ Docker
#
# 用 Node 22 而不是 20：better-sqlite3 v13 声明 engines>=22，
# 在 Node 20 上会退化成本地编译甚至装不上（package.json 的 engines 也是 >=22）。
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# 原生模块（better-sqlite3）优先用预编译包；没有预编译时回退到本地编译
# （argon2 已在 2026-09-15 移除：管理口令改成和 apikey 同一套 libsodium 加密，不再需要它）
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund

FROM node:22-bookworm-slim
# BIND 留空/0.0.0.0 = 所有地址：默认绑双栈 `::`，IPv4 与 IPv6 都能连（见 src/index.js 的 bindCandidates）
# TZ 不设：时区是应用自己的设置（后台「设置」页的 UTC 偏移），跟系统时区无关，见 src/store/timezone.js
ENV NODE_ENV=production \
    PORT=8787 \
    BIND=0.0.0.0 \
    DB_PATH=/app/data/app.db
WORKDIR /app
# 只带运行时需要的东西：依赖 + 启动所需的源码/迁移/前端页面
# （db.js 要 require('../knexfile')，app.js 要 public/，迁移脚本在 migrations/）
COPY --from=deps /app/node_modules ./node_modules
COPY package.json knexfile.js ./
COPY migrations ./migrations
COPY src ./src
COPY public ./public
# 维护脚本也带上：忘了管理密码时在容器里直接跑（跑完不用重启，刷新 /admin 就是「首次设置」页）
#   docker exec nszzj-free-llm-aggregator node scripts/reset-credentials.js
COPY scripts ./scripts
# 非 root 运行（审计 H2）：容器里跑的是别人写的模型网关代码，一旦某个依赖出 RCE，
# 至少别让攻击者直接拿到 root、也别让他随便改挂载进来的宿主机目录。
# 代价：宿主机上的 ./data 必须属于这个 uid（见 docker-compose.yml 里的说明），
# 否则容器内写不进去（Linux 上先执行：sudo chown -R 10001:10001 ./data）。
RUN groupadd -r app && useradd -r -g app -u 10001 app \
  && mkdir -p /app/data \
  && chown -R app:app /app
USER 10001:app
EXPOSE 8787
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# 主密钥与数据都不进镜像：
#   - 数据落在挂卷 /app/data（SQLite）；
#   - APP_SECRET 缺省会**自动生成**并存成 /app/data/app-secret.key（重启、重建容器都不变，
#     备份数据目录就够了）；想自己管密钥就设 APP_SECRET 环境变量。
# 首次装完打开 /admin 会出现「首次设置」页，在那儿设管理密码和下游 apikey ——
# 所以 .env 里不需要写任何明文配置，什么都不填也能跑。
CMD ["node", "src/index.js"]
