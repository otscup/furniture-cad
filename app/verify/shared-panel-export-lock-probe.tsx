import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { CommandBus } from '../src/core/commandBus.ts';
import type { Project } from '../src/core/types.ts';
import { ExportPanel } from '../src/ui/panels/ExportPanel.tsx';

export async function probeExportPanelLock(bus: CommandBus, project: Project, events: { requests: number; downloads: number }) {
  const host = document.createElement('div');
  host.dataset.testid = 'b48-export-lock-host';
  host.style.cssText = 'position:fixed;left:-12000px;top:0;width:1280px;height:900px;overflow:auto';
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(createElement(ExportPanel, {
    bus,
    version: 48,
    token: null,
    savedAt: null,
    remoteStatusReady: true,
    remoteStatusDiffers: false,
    remoteLiveModelVersion: 48,
    confirmedProject: project,
    projectSnapshotId: 'b48-draft-lock',
    projectSnapshotHash: 'a'.repeat(64),
    projectSnapshotVersion: 48,
    unconfirmedSharedPanelDraft: true,
    onOpenRemoteDrafts: () => undefined,
    onToast: () => undefined,
  }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  const kinds = ['pdf', 'dxf', 'csv', 'roombook'] as const;
  const buttons = Object.fromEntries(kinds.map((kind) => [kind, host.querySelector<HTMLButtonElement>(`[data-testid="production-export-${kind}"]`)]));
  const warning = host.querySelector('[data-testid="export-blocked-shared-panel-draft"]')?.textContent ?? '';
  for (const button of Object.values(buttons)) button?.click();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const result = {
    disabled: Object.fromEntries(Object.entries(buttons).map(([kind, button]) => [kind, button?.disabled === true])),
    warning,
    requestCount: events.requests,
    downloadCount: events.downloads,
    projectSharedCount: bus.getState().sharedPanels?.length ?? 0,
  };
  root.unmount();
  host.remove();
  return result;
}
