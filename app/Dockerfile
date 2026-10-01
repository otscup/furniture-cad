# ══════════════════════════════════════════════════════════════════════
#  家具 CAD 服务 —— 容器化部署
#
#  两阶段：
#    build  全量依赖（含 vite devDeps）构建 dist
#    run    仅生产依赖 + Python3/ezdxf（DXF 导出微服务在容器内直跑）
#
#  安全模型不变：服务自身无 TLS。容器里必须 APP_HOST=0.0.0.0
#  （Docker 端口发布的前提），公网 TLS 由前置反代终止 —— 见 DEPLOY.md。
#  运行时数据（账号库/审计/记忆/.env）全部落在 /app/data，由挂载卷持久化。
# ══════════════════════════════════════════════════════════════════════

# ── 阶段一：构建前端产物 ──
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── 阶段二：运行时 ──
FROM node:22-slim
# ezdxf 装进系统 Python（bookworm 需要 --break-system-packages）；
# ezdxf 有预编译 wheel，无需编译器工具链，slim 底座即可。
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --break-system-packages --no-cache-dir "ezdxf==1.4.4"

ENV APP_PYTHON=/usr/bin/python3 \
    APP_HOST=0.0.0.0 \
    PORT=8787 \
    NODE_ENV=production

WORKDIR /app
# 生产依赖只有 nodemailer；devDeps（vite 等）不进运行镜像
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY py ./py
# 运行时数据目录（账号库/审计/记忆/验证码库/.env 都会被 APP_*_PATH 指到这里）
RUN mkdir -p /app/data

EXPOSE 8787
USER node
CMD ["node", "server/server.mjs"]
