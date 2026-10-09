# 家具 CAD（furniture-cad）

浏览器端参数化定制家具设计与生产系统。**语义模型（JSON）是唯一真相源**——2D 视图、3D、DXF、开料清单全部同源派生；自然语言入口，可被 MCP 驱动。

## 快速开始

```bash
cd app
npm ci
npm run build        # 前端产物 → dist/
npm start            # 服务 http://127.0.0.1:8787（首次打开即建 owner 账号）
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run build` | 类型检查 + 前端构建 |
| `npm run typecheck` | `tsc --noEmit` 仅类型检查 |
| `npm run verify:all` | 全量验收链（类型 + 60+ 专项 + 浏览器 UI） |
| `npm run verify:mcp` | MCP 只读层专项（125 项） |
| `npm run verify:ui` | 真实浏览器探针（686 项，需 Chrome） |

Linux 注意：测试脚本的 Python 解析优先级为 `APP_PYTHON` → 项目根 `.venv` → `python3` → `python`；浏览器探针的 Chrome 查找优先级为 `CHROME_PATH` → `which chromium/chrome` → Windows 硬编码路径。

## 架构速览

- **语义模型 = 唯一真相源**：派生数据（几何/板件/清单）永不写项目文件，只存 authored。
- **AI 只出 Command、永不输出几何/坐标**；唯一写入口 `CommandBus`，两段式 dry-run → 确认 → commit。
- **Draft 流程**：MCP 写操作只改 draft，不碰 live；`cad.validate` 校验 → `cad.apply_draft` 合并到 live。`cad.get_state` 读的是 live。
- **MCP 工具**（`POST /mcp`，Streamable HTTP）：
  - 只读：`cad.get_state` / `cad.validate`
  - 写（进 draft）：`cad.create_cabinet` / `cad.place_cabinet` / `cad.update_object` / `cad.delete_object` / `cad.create_room` / `cad.draw_wall` / `cad.submit_proposal`
  - 草稿管理：`cad.apply_draft`（admin+，乐观锁）/ `cad.discard_draft` / `cad.list_drafts`
  - 长期 token（PAT，只存 sha256）走 `AuthStore` 鉴权
- **生产部署**：群晖 NAS Docker（`app/docker-compose.yml`），数据卷 `./data`，详见 `app/DEPLOY.md` 与仓库根 `deploy-nas.md`。一键更新：`bash app/update-nas.sh`

## 功能特性

- **三视图**：立面外观图 + 立面结构图（PDF 式排版，每柜一块、上下叠放）+ 独立 3D
- **导出**：DXF、按房间图纸册（HTML→PDF）、开料清单（CSV）
- **视图**：2D Canvas + Three.js 3D，可切换
- **账号体系**：owner/admin/designer/readonly 四档角色，PAT 长期 token
- **AI 面板**：多图上传（效果图/尺寸图标记）、Agent 对话建模

## 文档

- 主方案：`docs/AI-Web-CAD-Furniture-Master-Plan-v0.1.md`
- P10.0 架构审查：`docs/P10.0-MCP-Architecture-Review.md`
- 各阶段报告：`docs/P*Completion-Report.md`
- 知识库（Inkstone「家具CAD」文件夹）有各阶段提炼与执行报告，冲突时以仓库原文为准。

## 开发约定

- 多文件改动必须合成**一次提交、一次推送**（远端只新增一个 commit）
- 发布前：本地 build 通过 → 真实浏览器验收 → 再推 GitHub → 再部署 NAS
- 健康检查只证明服务活着，不证明功能正确；视觉验收必须看真实截图
