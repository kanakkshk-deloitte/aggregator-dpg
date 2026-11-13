import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DASHBOARD_BULK_ACTIONS } from '../bulk-actions';
import { dashboardService, triggerCsvDownload } from '../dashboard.service';

vi.mock('../dashboard.service', async () => {
  const original = await vi.importActual('../dashboard.service');
  return { ...(original as object), triggerCsvDownload: vi.fn() };
});

const baseRow = (id: string) => ({
  id,
  name: 'X',
  joined: '2026-01-01',
  status: 'active',
  profile: { complete: true },
  initiated: { create: 0, accept: 0, reject: 0, cancel: 0 },
  received: { create: 0, accept: 0, reject: 0, cancel: 0 },
});

describe('export_selected_csv bulk action', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('builds a CSV client-side and triggers a download without calling the server', async () => {
    const action = DASHBOARD_BULK_ACTIONS.find((a) => a.id === 'export_selected_csv');
    expect(action).toBeDefined();
    expect(action!.kind).toBe('client');

    const exportSpy = vi.spyOn(dashboardService, 'dashboardExportProfiles');
    await action!.run([baseRow('row-1'), baseRow('row-2')] as never, { domain: 'seeker' } as never);

    expect(exportSpy).not.toHaveBeenCalled();
    expect(triggerCsvDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: expect.stringMatching(/^dashboard-seeker-selected-\d{4}-\d{2}-\d{2}\.csv$/),
      }),
    );
  });
});

describe('export_profile_data bulk action', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('sends only real item_ids (drops synthetic row-* ids)', async () => {
    const action = DASHBOARD_BULK_ACTIONS.find((a) => a.id === 'export_profile_data');
    expect(action).toBeDefined();
    expect(action!.kind).toBe('server');

    const spy = vi
      .spyOn(dashboardService, 'dashboardExportProfiles')
      .mockResolvedValue({ blob: new Blob(['item_id\r\ni1']), filename: 'profiles-seeker.csv' });

    await action!.run(
      [baseRow('11111111-1111-4111-8111-111111111111'), baseRow('row-2')] as never,
      { domain: 'seeker' } as never,
    );

    expect(spy).toHaveBeenCalledWith({
      domain: 'seeker',
      itemIds: ['11111111-1111-4111-8111-111111111111'],
    });
  });

  it('no-ops when every selected row is synthetic (no real item ids)', async () => {
    const action = DASHBOARD_BULK_ACTIONS.find((a) => a.id === 'export_profile_data');
    const spy = vi.spyOn(dashboardService, 'dashboardExportProfiles');
    await action!.run([baseRow('row-1'), baseRow('row-2')] as never, { domain: 'seeker' } as never);
    expect(spy).not.toHaveBeenCalled();
  });
});
