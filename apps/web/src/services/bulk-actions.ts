/**
 * Bulk-action registry for the dashboard participant table (web app).
 *
 * The bulk bar renders whatever {@link BulkAction} entries it is given. To
 * add an action, append one here; server actions also need a BFF allowlist entry.
 *
 * @module apps/web/services/bulk-actions
 */

import type { IconName } from '../icons';
import type { ParticipantBase } from '../types';
import { dashboardService } from './dashboard.service';
import { triggerCsvDownload } from './dashboard.service';
import { buildParticipantCsv } from './participant-csv';

/** Context the bulk bar passes to every action run. */
export interface BulkActionContext {
  /** Domain id the table is showing (e.g. `seeker`). */
  domain: string;
}

/**
 * One bulk action the operator can run on the current selection.
 *
 * `kind` is informational; the bar runs both kinds the same way.
 */
export interface BulkAction {
  /** Stable key; for server actions this is also the BFF action name. */
  id: string;
  /** `dashboard.bulk.*` i18n key for the button label. */
  labelKey: string;
  icon: IconName;
  kind: 'client' | 'server';
  /** The capability needed to see the action (RBAC); the API also checks it. */
  capability: string;
  /**
   * Executes the action against the selected rows.
   *
   * @param rows - Snapshot of the selected rows (may span pages).
   * @param ctx - Domain context for server calls / filenames.
   * @throws {Error} When the action fails; the bar shows the message.
   */
  run(rows: ParticipantBase[], ctx: BulkActionContext): Promise<void>;
}

/**
 * Default dashboard bulk actions.
 *
 * `export_selected_csv` builds a CSV of the selected rows in the browser.
 * `export_profile_data` exports full profile data for the selected items from the server.
 */
export const DASHBOARD_BULK_ACTIONS: BulkAction[] = [
  {
    id: 'export_selected_csv',
    labelKey: 'bulk.exportSelected',
    icon: 'download',
    kind: 'client',
    capability: 'profiles.export',
    run: async (rows, ctx) => {
      const csv = buildParticipantCsv(rows);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const date = new Date().toISOString().slice(0, 10);
      triggerCsvDownload({ blob, filename: `dashboard-${ctx.domain}-selected-${date}.csv` });
    },
  },
  {
    id: 'export_profile_data',
    labelKey: 'bulk.exportProfileData',
    icon: 'download',
    kind: 'server',
    capability: 'profiles.view_pii',
    run: async (rows, ctx) => {
      const itemIds = rows.map((r) => r.id).filter((id) => !id.startsWith('row-'));
      if (itemIds.length === 0) return;
      const { blob, filename } = await dashboardService.dashboardExportProfiles({
        domain: ctx.domain,
        itemIds,
      });
      triggerCsvDownload({ blob, filename });
    },
  },
];
