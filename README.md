# 家具 CAD（furniture-cad）

浏览器端参数化定制家具设计与生产系统：**语义模型（JSON）是唯一真相源**，2D / 3D / DXF / 清单全部同源派生；自然语言入口，可被 MCP 驱动。

## 快速开始

```bash
cd app
npm ci
npm run build        # 前端产物 → dist/
npm start            # 服务 http://127.0.0.1:8787（首次打开即建 owner 账号）
```

常用脚本（`app/package.json`）：

| 命令 | 说明 |
|------|------|
| `npm run typecheck` | `tsc --noEmit` 类型检查 |
| `npm run verify:all` | 全量验收链（类型 + 60+ 专项 + 浏览器 UI） |
| `npm run verify:mcp` | MCP 只读层专项（125 项） |
| `npm run verify:ui` | 真实浏览器探针（686 项，需 Chrome） |
| `APP_PYTHON=... npm run verify:all` | 指定 Python 解释器（Linux 下可用 `python3`，脚本自动 fallback） |

Linux 注意：测试脚本的 Python 解析优先级为 `APP_PYTHON` → 项目根 `.venv`（Windows `Scripts/python.exe` / POSIX `bin/python`）→ `python3` → `python`；浏览器探针的 Chrome 查找优先级为 `CHROME_PATH` 环境变量 → `which chromium/chrome` → Windows 硬编码路径。

## 架构速览

- **语义模型 = 唯一真相源**：派生数据（几何/板件/清单）永不写项目文件，只存 authored。
- **AI 只出 Command、永不输出几何/坐标**；唯一写入口 `CommandBus`，两段式 dry-run → 确认 → commit。
- **MCP（P10.0-S2 起）**：`POST /mcp`（Streamable HTTP，同进程），只读工具 `cad.get_state` / `cad.validate`；长期 token（PAT，只存 sha256）走既有 `AuthStore` 鉴权。写工具（P10.0-S4/S5）：`cad.create_cabinet` / `cad.place_cabinet` / `cad.update_object` / `cad.delete_object` / `cad.create_room` / `cad.draw_wall`（IR-3 已开放）/ `cad.submit_proposal`（designer+，只写 draft）+ `cad.apply_draft`（admin+，乐观锁）/ `cad.discard_draft`（按归属）+ `cad.list_drafts`（读）。一键更新 NAS：`bash app/update-nas.sh`（先按头注释装一次）。
- **生产部署**：群晖 NAS Docker（`app/docker-compose.yml`），数据卷 `./data`，详见 `app/DEPLOY.md` 与仓库根 `deploy-nas.md`。

## 文档

- 主方案：`docs/AI-Web-CAD-Furniture-Master-Plan-v0.1.md`
- P10.0 架构审查：`docs/P10.0-MCP-Architecture-Review.md`
- 知识库（Inkstone「家具CAD」文件夹）有各阶段提炼与执行报告，冲突时以仓库原文为准。
