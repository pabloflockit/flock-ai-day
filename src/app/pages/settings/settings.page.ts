import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { setGeneralSettings } from '../../../../shared/config-edit.mjs';
import { ConfigEditor } from '../../core/config-editor';
import { errorMessageEs } from '../../core/error-messages';
import { toOpError } from '../../core/op';
import { AppStore } from '../../core/store/app-store';
import { ToastService } from '../../shared/ui/toast.service';

/** A days field the user can leave empty or half typed; anything but a whole number is `NaN`. */
const toDays = (text: string): number => (/^\s*\d+\s*$/.test(text) ? Number(text) : Number.NaN);

/**
 * General settings (plan §6.1.6): business days for stale/aging units, where the status mapping
 * lives (Conexión), and the AI reports switch with its write-only API key.
 */
@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.scss',
})
export class SettingsPage {
  readonly #store = inject(AppStore);
  readonly #editor = inject(ConfigEditor);
  readonly #toasts = inject(ToastService);

  readonly configState = this.#store.configState;
  readonly settings = computed(() => this.#store.config()?.settings ?? null);
  readonly aiKeyStored = this.#store.aiKeyStored;
  readonly overrideCount = computed(() => Object.keys(this.#store.config()?.jira.statusCategoryOverrides ?? {}).length);
  /** Reports are switched on but nothing can call the model yet. */
  readonly needsKey = computed(() => this.settings()?.ai.enabled === true && this.aiKeyStored() === false);

  // Drafts, reset whenever the saved settings change.
  readonly staleDays = linkedSignal(() => String(this.settings()?.staleBusinessDays ?? ''));
  readonly agingDays = linkedSignal(() => String(this.settings()?.agingBusinessDays ?? ''));
  readonly staleError = signal<string | null>(null);
  readonly agingError = signal<string | null>(null);
  readonly savingDays = signal(false);

  /** Write-only: cleared once stored and never rendered back. */
  readonly aiKey = signal('');
  readonly aiKeyError = signal<string | null>(null);
  readonly savingKey = signal(false);
  readonly savingAi = signal(false);

  constructor() {
    void this.#store.loadConfig();
    void this.#store.loadConnectionStatus();
  }

  async saveDays(): Promise<void> {
    const saved = this.settings();
    if (!saved || this.savingDays()) return;
    const staleBusinessDays = toDays(this.staleDays());
    const agingBusinessDays = toDays(this.agingDays());
    this.savingDays.set(true);
    this.staleError.set(null);
    this.agingError.set(null);
    try {
      const result = await this.#editor.apply(
        (c) => setGeneralSettings(c, { staleBusinessDays, agingBusinessDays, aiEnabled: saved.ai.enabled }),
        'Días hábiles guardados.',
      );
      if (result.ok) return;
      this.staleError.set(result.issues.find((i) => i.path === 'settings.staleBusinessDays')?.message ?? null);
      this.agingError.set(result.issues.find((i) => i.path === 'settings.agingBusinessDays')?.message ?? null);
    } finally {
      this.savingDays.set(false);
    }
  }

  /** The switch saves right away, keeping the saved days (an unsaved draft is not applied by surprise). */
  async setAiEnabled(aiEnabled: boolean): Promise<void> {
    const saved = this.settings();
    if (!saved || this.savingAi()) return;
    this.savingAi.set(true);
    try {
      await this.#editor.apply(
        (c) =>
          setGeneralSettings(c, {
            staleBusinessDays: saved.staleBusinessDays,
            agingBusinessDays: saved.agingBusinessDays,
            aiEnabled,
          }),
        aiEnabled ? 'Informes con IA activados.' : 'Informes con IA desactivados.',
      );
    } finally {
      this.savingAi.set(false);
    }
  }

  async saveKey(): Promise<void> {
    const key = this.aiKey().trim();
    if (!key || this.savingKey()) return;
    this.savingKey.set(true);
    this.aiKeyError.set(null);
    try {
      await this.#store.saveAiKey(key);
      this.aiKey.set('');
      this.#toasts.success('API key guardada.');
    } catch (error) {
      this.aiKeyError.set(errorMessageEs(toOpError(error).code));
    } finally {
      this.savingKey.set(false);
    }
  }
}
