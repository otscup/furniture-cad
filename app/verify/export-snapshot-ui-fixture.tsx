import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CommandBus } from '../src/core/commandBus.ts';
import { createCabinet, emptyProject, rectRoom } from '../src/core/docFactory.ts';
import type { Project, RuleSet } from '../src/core/types.ts';
import rulesJson from '../src/core/ruleset/factory-default.json';
import { ExportPanel } from '../src/ui/panels/ExportPanel.tsx';

type RequestRecord = { url: string; body: Record<string, unknown> };
type TestHarness = {
  requests: RequestRecord[];
  toasts: Array<{ kind: string; message: string }>;
  setNextConflict: () => void;
  setLocalProject: (project: Project) => void;
};

declare global {
  interface Window { __snapshotExportTest: TestHarness }
}

const rules = rulesJson as RuleSet;
const baseProject = emptyProject({
  id: 'project_snapshot_ui_fixture',
  name: '快照导出 UI 验收',
  ruleSetId: rules.id,
});
const room = rectRoom({
  id: 'room_snapshot_ui_fixture',
  name: '验收房间',
  x: 0,
  y: 0,
  w: 5000,
  h: 4000,
  thickness: 120,
  height: 2700,
});
baseProject.rooms.push(room);
baseProject.cabinets.push(createCabinet({
  id: 'cab_snapshot_ui_fixture',
  name: '验收柜',
  roomId: room.id,
  x: 400,
  y: 60,
  rules,
  params: { width: 800, height: 2000, depth: 600 },
}));
const confirmedProject = structuredClone(baseProject);
const serverSnapshot = Object.freeze({
  projectSnapshotId: 'ws_snapshot_ui_fixture:v41:' + 'a'.repeat(64),
  projectSnapshotHash: 'a'.repeat(64),
  projectSnapshotVersion: 41,
});
const requests: RequestRecord[] = [];
const toasts: TestHarness['toasts'] = [];
let nextConflict = false;
const originalFetch = window.fetch.bind(window);

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('/api/export/')) return originalFetch(input, init);
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  requests.push({ url, body });
  if (nextConflict) {
    nextConflict = false;
    return new Response(JSON.stringify({
      ok: false,
      code: 'EXPORT_SNAPSHOT_CONFLICT',
      error: '提交快照版本与服务器当前 live 版本不一致，服务器拒绝导出。',
      mismatchFields: ['projectSnapshotVersion'],
      projectSnapshotVersion: 42,
    }), { status: 409, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }
  const name = url.endsWith('/pdf') ? 'fixture.pdf' : url.endsWith('/dxf') ? 'fixture.dxf' : url.endsWith('/roombook') ? 'fixture.html' : 'fixture.csv';
  return new Response('fixture export artifact', {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
    },
  });
};

// 验收运行在 headless Chrome；不创建实际下载文件。
URL.createObjectURL = () => 'blob:snapshot-export-ui-fixture';
URL.revokeObjectURL = () => undefined;

function Fixture(): React.ReactElement {
  const [bus, setBus] = useState(() => new CommandBus(confirmedProject, rules));
  window.__snapshotExportTest = {
    requests,
    toasts,
    setNextConflict: () => { nextConflict = true; },
    setLocalProject: (project) => setBus(new CommandBus(project, rules)),
  };
  return (
    <ExportPanel
      bus={bus}
      version={1}
      token={null}
      savedAt={null}
      remoteStatusReady
      remoteStatusDiffers={false}
      remoteLiveModelVersion={41}
      confirmedProject={confirmedProject}
      projectSnapshotId={serverSnapshot.projectSnapshotId}
      projectSnapshotHash={serverSnapshot.projectSnapshotHash}
      projectSnapshotVersion={serverSnapshot.projectSnapshotVersion}
      onOpenRemoteDrafts={() => undefined}
      onToast={(kind, message) => toasts.push({ kind, message })}
    />
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
