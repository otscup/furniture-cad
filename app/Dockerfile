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

# ── 导出链的运行期源码（P10.0 S0 修复）────────────────────────────────
# 为什么运行镜像需要源码：
#   server.mjs:1580/:1612/:1658 在**运行期**用子进程直跑
#   `node --experimental-strip-types scripts/emit-*.ts`
#   （几何必须在后端从语义模型重算，不接受浏览器上传的图元）。
#   两个入口 import ../src/core|export/**，并**按路径读**
#   src/core/ruleset/factory-default.json（server 不传 rulesPath ⇒ 必落到这份）。
# 此前的缺陷：运行阶段只 COPY 了 dist/server/shared/py ⇒ 生产镜像里
#   既没有 scripts/ 也没有 src/ ⇒ /api/export/{dxf,cutlist,roombook} 全部 500
#   （Cannot find module '/app/scripts/emit-neutral.ts'）。
# 为什么只拷这几个目录（不写 `COPY src ./src`）：
#   实测运行期闭包只落在 scripts/ + src/core/ + src/export/（+ src/ai/memory.ts），
#   不含 src/ui、src/state、src/viewport（前端源码，运行镜像用不到）。
#   闭包由 verify/image-closure-acceptance.ts 静态守住，并已接入 verify:all ——
#   将来 emit 入口新增依赖若逃出这些目录，本地验收会先红，而不是等生产 500。
# ★ 规则集 JSON 是按路径读的，不出现在 import 图里 —— 它随 src/core 整目录一起进来，
#   任何"只拷 import 闭包文件"的写法都会漏掉它（已由断言单独守住）。
COPY scripts ./scripts
COPY src/core ./src/core
COPY src/export ./src/export
# src/ai/memory.ts：被 src/core/commandBus.ts（随 src/core 一起进镜像）运行期 import，
# 成对拷贝以免将来任何 core 模块开始加载 commandBus 时在生产静默解不开这个依赖。
COPY src/ai/memory.ts ./src/ai/memory.ts

# 运行时数据目录（账号库/审计/记忆/验证码库/.env 都会被 APP_*_PATH 指到这里）
RUN mkdir -p /app/data

EXPOSE 8787
USER node
CMD ["node", "server/server.mjs"]
