import { inject, Injectable } from '@angular/core';
import type { AppConfig } from '../../../proxy/config/normalize.mjs';
import type { EditIssue, EditResult } from '../../../shared/config-edit.mjs';
import { ToastService } from '../shared/ui/toast.service';
import { ProxyError } from './proxy-client';
import { AppStore } from './store/app-store';

export type ApplyResult = { ok: true } | { ok: false; issues: EditIssue[] };

/**
 * Single path for administration edits: run a pure `shared/config-edit.mjs` operation over the
 * current config, save it through `PUT /api/config` (the proxy normalizes and validates), and
 * report the outcome with a toast. The store keeps the normalized config the proxy returns.
 */
@Injectable({ providedIn: 'root' })
export class ConfigEditor {
  readonly #store = inject(AppStore);
  readonly #toasts = inject(ToastService);

  async apply(edit: (config: AppConfig) => EditResult, successMessage?: string): Promise<ApplyResult> {
    const config = this.#store.config();
    if (!config) return this.#fail([{ code: 'CONFIG_NOT_LOADED', path: '', message: 'La configuración todavía no se cargó.' }]);

    const result = edit(config);
    if (!result.ok) return this.#fail(result.issues);

    try {
      await this.#store.saveConfig(result.config);
    } catch (error) {
      return this.#fail(issuesFrom(error));
    }
    if (successMessage) this.#toasts.success(successMessage);
    return { ok: true };
  }

  #fail(issues: EditIssue[]): ApplyResult {
    this.#toasts.error(issues[0]?.message ?? 'No se pudo guardar la configuración.');
    return { ok: false, issues };
  }
}

function issuesFrom(error: unknown): EditIssue[] {
  if (error instanceof ProxyError) {
    const issues = (error.details as { issues?: EditIssue[] } | undefined)?.issues;
    if (error.code === 'VALIDATION_FAILED' && Array.isArray(issues) && issues.length > 0) return issues;
    return [{ code: error.code, path: '', message: error.message }];
  }
  return [{ code: 'UNKNOWN', path: '', message: error instanceof Error ? error.message : String(error) }];
}
