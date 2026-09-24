/**
 * ThreeViewport —— 3D 视口（派生视图的只读渲染 + 点选联动）。
 *
 *  ── 边界（与 2D Viewport 同一条架构铁律）──
 *    · 只消费 geom.bodies3d（派生体块），永不写模型；
 *    · 点击命中柜体 → setSelection([cabId])——选择是视图状态，不是模型；
 *    · 空白点击清空选择（CAD 习惯）；
 *    · 渲染器只认 bodies3d 数组，遇到意外数据跳过，绝不让界面白屏。
 *
 *  ── 坐标映射 ──
 *    世界 (x, y, z=高度) → three (x, y=z, z=y)；rotation.y = -rot（右手系差异，
 *    已在 bodies3d-acceptance §4 用镜像对称断言核对过旋转语义）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CommandBus } from '../core/commandBus.ts';
import type { Box3D } from '../core/geometry/bodies3d.ts';

const ROLE_COLOR: Record<string, number> = {
  side: 0xd8cfc0,
  top: 0xe2dacd,
  bottom: 0xd0c7b8,
  back: 0xb8afa2,
  plinth: 0x8f8577,
  divider: 0xd8cfc0,
  shelf: 0xefe8db,
  door: 0xc9b394,
  drawer: 0xc9b394,
  rod: 0x9a9a9a,
};
const SELECTED_COLOR = 0x4a90d9;
/** 单位盒：模块级共享（scale 定尺寸），永不 dispose —— 每次重建 new 会漏 GPU 内存 */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

interface Props {
  bus: CommandBus;
  version: number;
  selection: string[];
  setSelection: (ids: string[]) => void;
}

export function ThreeViewport({ bus, version, selection, setSelection }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const meshByCab = useRef<Map<string, { meshes: THREE.Mesh[]; roles: string[] }>>(new Map());
  const [ready, setReady] = useState(false);

  const bodies = useMemo<Box3D[]>(() => {
    try {
      return bus.derive().geom.bodies3d;
    } catch {
      return [];
    }
  }, [bus, version]);

  // ── 初始化场景（一次）──
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(host.clientWidth, host.clientHeight);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf2f0ec);
    scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    const dir = new THREE.DirectionalLight(0xffffff, 0.65);
    dir.position.set(1, 1.6, 0.8);
    scene.add(dir);
    // 地面网格：给用户一个"这是地面"的参照，避免 3D 悬空感
    const grid = new THREE.GridHelper(6000, 30, 0xcccccc, 0xe4e4e4);
    const gmat = grid.material as THREE.Material;
    gmat.transparent = true;
    gmat.opacity = 0.55;
    scene.add(grid);

    const camera = new THREE.PerspectiveCamera(45, host.clientWidth / Math.max(1, host.clientHeight), 10, 60000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.maxPolarAngle = Math.PI / 2 - 0.02; // 不许钻到地下

    const tick = (): void => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    let raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = Math.max(1, host.clientHeight);
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(host);

    rendererRef.current = renderer;
    sceneRef.current = scene;
    cameraRef.current = camera;
    controlsRef.current = controls;
    setReady(true);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
    };
  }, []);

  // ── bodies 变化 → 重建 mesh（dispose 旧的，绝不让 GPU 内存泄漏）──
  useEffect(() => {
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!scene || !camera || !controls) return;

    // 清旧
    for (const entry of meshByCab.current.values()) {
      for (const m of entry.meshes) {
        scene.remove(m);
        (m.material as THREE.Material).dispose();
      }
    }
    meshByCab.current = new Map();

    const group = new THREE.Group();
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };

    for (const b of bodies) {
      if (!(b.sx > 0 && b.sy > 0 && b.sz > 0)) continue; // 退化盒不画（验收层会报）
      const mat = new THREE.MeshLambertMaterial({ color: ROLE_COLOR[b.role] ?? 0xcccccc });
      const mesh = new THREE.Mesh(UNIT_BOX, mat);
      // 世界(x,y,z高度) → three(x, y=z, z=y)
      mesh.position.set(b.cx, b.cz, b.cy);
      mesh.rotation.y = (-b.rot * Math.PI) / 180;
      mesh.scale.set(b.sx, b.sz, b.sy);
      mesh.userData.cabId = b.cabId;
      group.add(mesh);
      const entry = meshByCab.current.get(b.cabId) ?? { meshes: [], roles: [] };
      entry.meshes.push(mesh);
      entry.roles.push(b.role);
      meshByCab.current.set(b.cabId, entry);

      min.x = Math.min(min.x, b.cx); max.x = Math.max(max.x, b.cx);
      min.y = Math.min(min.y, b.cz); max.y = Math.max(max.y, b.cz);
      min.z = Math.min(min.z, b.cy); max.z = Math.max(max.z, b.cy);
    }
    scene.add(group);

    // 取景：包围盒中心，斜视角俯视（3D 自己的取景，与 2D 相机无关）
    if (bodies.length > 0 && Number.isFinite(min.x)) {
      const cx = (min.x + max.x) / 2;
      const cy = (min.y + max.y) / 2;
      const cz = (min.z + max.z) / 2;
      const diag = Math.max(1200, Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z));
      camera.position.set(cx + diag * 0.75, cy + diag * 0.7, cz + diag * 0.9);
      controls.target.set(cx, cy, cz);
      controls.update();
    }
  }, [bodies, ready]);

  // ── 选中高亮（只改材质色，不动几何；卸色回到各 role 自己的色）──
  useEffect(() => {
    for (const entry of meshByCab.current.values()) {
      entry.meshes.forEach((m, i) => {
        const role = entry.roles[i];
        const isSel = selection.includes(m.userData.cabId as string);
        (m.material as THREE.MeshLambertMaterial).color.setHex(isSel ? SELECTED_COLOR : (ROLE_COLOR[role] ?? 0xcccccc));
      });
    }
  }, [selection, bodies]);

  // ── 点击选中（raycast；不写模型 —— 只改选择这个视图状态）──
  useEffect(() => {
    const renderer = rendererRef.current;
    const camera = cameraRef.current;
    if (!renderer || !camera) return;
    const el = renderer.domElement;

    const onClick = (e: MouseEvent): void => {
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const targets: THREE.Object3D[] = [];
      for (const entry of meshByCab.current.values()) targets.push(...entry.meshes);
      const hits = ray.intersectObjects(targets, false);
      const first = hits.find((h) => h.object.userData.cabId);
      if (first) {
        setSelection([first.object.userData.cabId as string]);
      } else {
        setSelection([]); // 点空白：清空选择（CAD 习惯）
      }
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [setSelection, ready]);

  return (
    <div ref={wrapRef} className="vp vp-3d" style={{ position: 'relative', flex: 1 }}>
      <div ref={canvasHostRef} style={{ position: 'absolute', inset: 0 }} />
      <div className="vp-hud-item vp-hud-3d">
        3D 视图 · 只读 —— 拖动旋转 / 滚轮缩放 / 点击柜体选中；改尺寸回平面图
      </div>
    </div>
  );
}
