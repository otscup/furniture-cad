"""
把生成的 DXF 渲染成 PNG —— 用于"人眼检查"这一步。

本质是：用 ezdxf 的 drawing 插件重新读回 DXF 并按图层样式绘制。
能正常画出来 = 实体几何合法；中文能显示 = 字体链路通。
"""
from __future__ import annotations

import sys
from pathlib import Path

import ezdxf
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from ezdxf.addons.drawing import Frontend, RenderContext  # noqa: E402
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DXF = ROOT / "out" / ("Cabinet_001_R2007.dxf" if len(sys.argv) < 2 else sys.argv[1])
OUTDIR = ROOT / "out"

# 中文字体：优先 Windows 自带
for fam in ("Microsoft YaHei", "SimHei", "SimSun", "Noto Sans CJK SC"):
    plt.rcParams["font.sans-serif"] = [fam]
    break
plt.rcParams["axes.unicode_minus"] = False


def render(xlim, ylim, out_name, title, px=2000, dark=True):
    doc = ezdxf.readfile(DXF)
    msp = doc.modelspace()

    # 诊断：DIMENSION 必须真的生成了几何块，否则只是一条空记录
    dims = list(msp.query("DIMENSION"))
    with_geom = [d for d in dims if d.dxf.hasattr("geometry") and d.dxf.geometry]
    print(f"        DIMENSION {len(dims)} 个，其中已生成几何块 {len(with_geom)} 个")

    fig = plt.figure(figsize=(px / 100, px / 100 * (ylim[1] - ylim[0]) / (xlim[1] - xlim[0])), dpi=100)
    # 深色底 = 模拟 AutoCAD 模型空间（ACI 颜色 7 是"黑/白"随背景反转，白底上会隐形）
    fig.patch.set_facecolor("black" if dark else "white")
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    ax.set_facecolor("black" if dark else "white")
    ctx = RenderContext(doc)
    ctx.set_current_layout(msp)
    Frontend(ctx, MatplotlibBackend(ax)).draw_layout(msp, finalize=False)
    ax.set_xlim(*xlim)
    ax.set_ylim(*ylim)
    fig.savefig(OUTDIR / out_name, dpi=100, facecolor=fig.get_facecolor())
    plt.close(fig)
    print(f"OK  -> {out_name}   ({title})")


if __name__ == "__main__":
    render((-400, 2700), (-500, 2800), "preview_elevation.png", "正立面图")
    render((4300, 11300), (-11900, 2700), "preview_panels.png", "板件图")
