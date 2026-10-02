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

# ── MCP 基础层的运行期源码（P10.0 S2）────────────────────────────────
# 为什么运行镜像还需要 src/workspace：
#   server/workspaceHost.mjs 在**启动时**用动态 import 装载
#   `src/workspace/workspace.ts`（服务端 Workspace 持久实体），MCP 只读工具
#   `cad.get_state` / `cad.validate` 都从它取数 —— 它不在上面那条 emit 闭包里，
#   所以必须单独拷。漏拷的后果与 S0 那个坑同类：镜像能起来、/api 正常，
#   只有 /mcp 的工具返回 WORKSPACE_UNAVAILABLE（"装载失败"），
#   而宿主源码树里永远复现不出来。
#   MCP SDK 与 zod 由下面那条 `npm ci --omit=dev` 装（都在 dependencies），
#   不需要也不能 COPY node_modules。
#   闭包由 verify/image-closure-acceptance.ts 的 G 段（**服务端**闭包）守住：
#   以后 server 再 import 新的 src/ 文件而忘了改这里，本地验收会先红。
COPY src/workspace ./src/workspace

# ── MCP 写工具的运行期源码（P10.0 S4/S5）────────────────────────────────
# 为什么运行镜像还需要 src/ai/compile*.ts、planRunner.ts、proposal.ts：
#   server/mcpWrite.mjs 在**调用时**用动态 import 装载它们 —— 写工具复用
#   AI 编译器 compileAction（与内置 AI 逐字节同一条编译路）与
#   compileProposal → dryRunPlan 链（submit_proposal），MCP 只做参数搬运。
#   它们的运行期依赖全在 src/core（已拷），type-only import 会被 strip-types 擦除，
#   所以只需拷这 4 个文件本身（不拷整个 src/ai/，那里面还有 planner/vision 等
#   运行镜像用不到的东西）。漏拷的后果：写工具调用时动态 import 抛错 → 500，
#   而宿主源码树里永远复现不出来（与 S0 那坑同类）。
#   闭包由 verify/image-closure-acceptance.ts 的 G 段守住。
COPY src/ai/compile.ts ./src/ai/compile.ts
COPY src/ai/compileProposal.ts ./src/ai/compileProposal.ts
COPY src/ai/planRunner.ts ./src/ai/planRunner.ts
COPY src/ai/proposal.ts ./src/ai/proposal.ts

# 运行时数据目录（账号库/审计/记忆/验证码库/.env 都会被 APP_*_PATH 指到这里）
RUN mkdir -p /app/data

# ── 权限归一（P10.0-IR3 修复）────────────────────────────────────────
# 为什么需要这一行：
#   Docker COPY 会把构建上下文文件的 POSIX 权限和 UID 原样带进镜像。
#   宿主机上的文件可能因各种原因变成 700 / 属主非 node（NAS 上 tar 解压、
#   umask、旧部署残留都可能），而容器以 `node`（UID 1000）运行，
#   读不到这些文件就会 EACCES crash-loop（2026-10-03 生产事故）。
#   在镜像里把 /app 统一 chown 给 node，构建产物就不再依赖宿主机权限。
#   注意：/app/data 是卷挂载点，运行时会被宿主机目录覆盖，这里的 chown
#   只影响镜像内默认值；data/ 的权限由部署脚本单独保障（dataWritable 检查）。
RUN chown -R node:node /app

EXPOSE 8787
USER node
CMD ["node", "server/server.mjs"]
