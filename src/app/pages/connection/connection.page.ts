import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { setComponentLayer, setJiraConnection, setJiraParticularities } from '../../../../shared/config-edit.mjs';
import { componentLayerRows } from '../../../../shared/config-view.mjs';
import { ConfigEditor } from '../../core/config-editor';
import { idle, track, type Op } from '../../core/op';
import { ProxyClient } from '../../core/proxy-client';
import { AppStore } from '../../core/store/app-store';
import { Icon } from '../../shared/ui/icon';
import { CATEGORY_STATE } from '../../shared/ui/state';

type Category = 'todo' | 'doing' | 'done';
type EpicLinkMode = 'auto' | 'parent' | 'epic_link';

interface JiraStatus {
  id: string;
  name: string;
  statusCategory: Category | null;
}
interface JiraField {
  id: string;
  name: string;
  custom: boolean;
}

interface JiraComponent {
  id: string;
  name: string;
}
type Layer = 'frontend' | 'backend' | 'functional';

export const LAYER_LABEL: Record<Layer, string> = { frontend: 'Frontend', backend: 'Backend', functional: 'Funcional' };

export const CATEGORY_LABEL: Record<Category, string> = { todo: 'Por hacer', doing: 'En curso', done: 'Hecho' };

const STEPS = [
  { n: 1, label: 'Sitio' },
  { n: 2, label: 'Credenciales' },
  { n: 3, label: 'Particularidades' },
] as const;

const LINK_MODES: readonly { value: EpicLinkMode; label: string; hint: string }[] = [
  {
    value: 'auto',
    label: 'Automático (recomendado)',
    hint: 'Busca los hijos por el vínculo padre; si una épica no devuelve ninguno y hay un campo Epic Link elegido, prueba con ese campo.',
  },
  { value: 'parent', label: 'Padre', hint: 'Jira Cloud actual: las tareas tienen a la épica como padre.' },
  { value: 'epic_link', label: 'Campo Epic Link', hint: 'Sitios que todavía usan el campo heredado Epic Link.' },
];

/**
 * Jira connection (plan §6.1.1). First run: a three-step wizard — site ("Verificar"), credentials
 * ("Probar" saves URL, email and token and only then tests, so nothing unsaved is ever tested),
 * particularities. Afterwards the same blocks as an editable screen where the token is only
 * replaced: it is write-only and never rendered.
 */
@Component({
  selector: 'app-connection-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, NgTemplateOutlet],
  templateUrl: './connection.page.html',
  styleUrl: './connection.page.scss',
})
export class ConnectionPage {
  readonly #store = inject(AppStore);
  readonly #proxy = inject(ProxyClient);
  readonly #editor = inject(ConfigEditor);

  readonly steps = STEPS;
  readonly linkModes = LINK_MODES;
  readonly categoryLabel = CATEGORY_LABEL;
  readonly categoryState = CATEGORY_STATE;
  readonly categories = Object.keys(CATEGORY_LABEL) as Category[];

  readonly config = this.#store.config;
  readonly configState = this.#store.configState;
  readonly tokenStored = this.#store.tokenStored;

  /** Decided once, when the config and the token presence are known. */
  readonly mode = signal<'loading' | 'wizard' | 'edit'>('loading');
  readonly step = signal<1 | 2 | 3>(1);
  readonly #statusChecked = signal(false);

  // Site and credentials.
  readonly baseUrl = linkedSignal(() => this.config()?.jira.baseUrl ?? '');
  readonly email = linkedSignal(() => this.config()?.jira.email ?? '');
  /** Write-only: cleared once stored and never rendered. */
  readonly token = signal('');
  readonly verify = signal<Op<{ deploymentType: string; baseUrl: string }>>(idle());
  readonly test = signal<Op<{ displayName: string }>>(idle());

  /** The URL in the input is exactly the one the proxy verified as Jira Cloud. */
  readonly siteVerified = computed(
    () => this.verify().status === 'ok' && this.verify().data?.baseUrl === this.baseUrl().trim(),
  );
  /** Verified now, or unchanged from the saved (already verified) URL. */
  readonly siteAccepted = computed(() => {
    const url = this.baseUrl().trim();
    return this.siteVerified() || (url !== '' && url === this.config()?.jira.baseUrl);
  });
  readonly canTest = computed(
    () =>
      this.siteAccepted() &&
      this.email().trim() !== '' &&
      (this.token().trim() !== '' || this.tokenStored() === true) &&
      this.test().status !== 'loading',
  );

  // Particularities.
  readonly epicLinkMode = linkedSignal<EpicLinkMode>(() => this.config()?.jira.epicLinkMode ?? 'auto');
  readonly epicLinkFieldId = linkedSignal(() => this.config()?.jira.epicLinkFieldId ?? '');
  /**
   * Saved overrides compared by content: any config reload (e.g. saving a component layer) builds
   * a new object, and an identity change would reset the unsaved draft below.
   */
  readonly #savedOverrides = computed<Record<string, Category>>(
    () => ({ ...(this.config()?.jira.statusCategoryOverrides ?? {}) }),
    { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  readonly overrides = linkedSignal<Record<string, Category>>(() => ({ ...this.#savedOverrides() }));
  readonly linkHint = computed(() => LINK_MODES.find((m) => m.value === this.epicLinkMode())?.hint ?? '');
  readonly statusesOp = signal<Op<JiraStatus[]>>(idle());
  readonly fieldsOp = signal<Op<JiraField[]>>(idle());
  readonly statuses = computed(() => this.statusesOp().data ?? []);
  readonly customFields = computed(() => (this.fieldsOp().data ?? []).filter((f) => f.custom));
  readonly saving = signal(false);

  // Component layers (sprint report): one block per Jira project key, components loaded on demand.
  readonly layerLabel = LAYER_LABEL;
  readonly layers = Object.keys(LAYER_LABEL) as Layer[];
  readonly layerRows = computed(() => {
    const config = this.config();
    return config ? componentLayerRows(config) : [];
  });
  readonly componentOps = signal<Record<string, Op<JiraComponent[]>>>({});

  constructor() {
    void this.#store.loadConfig();
    void this.#store.loadConnectionStatus().finally(() => this.#statusChecked.set(true));

    effect(() => {
      if (this.mode() !== 'loading' || !this.config() || !this.#statusChecked()) return;
      untracked(() => {
        const ready = this.#store.jiraReady();
        this.mode.set(ready ? 'edit' : 'wizard');
        if (ready) void this.loadMeta();
      });
    });
  }

  async verifyUrl(): Promise<void> {
    const ok = await track(this.verify, () =>
      this.#proxy.post<{ deploymentType: string; baseUrl: string }>('/api/connection/verify', {
        baseUrl: this.baseUrl().trim(),
      }),
    );
    // The input shows the normalized origin the proxy verified, so "verified" is exactly what is saved.
    const verified = this.verify().data;
    if (ok && verified) this.baseUrl.set(verified.baseUrl);
  }

  /** Saves URL + email (and the token, if one was typed), then calls `/api/connection/test`. */
  async saveAndTest(): Promise<void> {
    const baseUrl = this.baseUrl().trim();
    const token = this.token().trim();
    this.test.set({ status: 'loading', data: null, error: null });
    const saved = await this.#editor.apply((c) => setJiraConnection(c, { baseUrl, email: this.email() }));
    if (!saved.ok) {
      const issue = saved.issues[0];
      this.test.set({ status: 'error', data: null, error: { code: issue.code, message: issue.message } });
      return;
    }
    await track(this.test, async () => {
      if (token) {
        await this.#store.saveJiraToken(token);
        this.token.set('');
      }
      const me = await this.#proxy.post<{ displayName: string }>('/api/connection/test');
      return { displayName: me.displayName };
    });
  }

  canAdvance(): boolean {
    if (this.step() === 1) return this.siteAccepted();
    if (this.step() === 2) return this.test().status === 'ok';
    return false;
  }

  next(): void {
    if (!this.canAdvance()) return;
    this.step.update((s) => (s === 1 ? 2 : 3));
    if (this.step() === 3) void this.loadMeta();
  }

  back(): void {
    this.step.update((s) => (s === 3 ? 2 : 1));
  }

  /** Statuses and fields of the site, for the overrides table and the Epic Link field. */
  async loadMeta(): Promise<void> {
    await Promise.all([
      track(this.statusesOp, () => this.#proxy.get<JiraStatus[]>('/api/jira/statuses')),
      track(this.fieldsOp, () => this.#proxy.get<JiraField[]>('/api/jira/fields')),
    ]);
  }

  /** Components of one Jira project, for its layer selects. */
  async loadComponents(projectKey: string): Promise<void> {
    const op = signal<Op<JiraComponent[]>>(idle());
    const publish = () => this.componentOps.update((all) => ({ ...all, [projectKey]: op() }));
    const pending = track(op, () =>
      this.#proxy.get<JiraComponent[]>(`/api/jira/projects/${encodeURIComponent(projectKey)}/components`),
    );
    publish();
    await pending;
    publish();
  }

  /** The layer a component is mapped to, or `''`. */
  layerOf(projectKey: string, componentId: string): Layer | '' {
    const entry = this.config()?.jira.componentLayers.find(
      (l) => l.projectKey === projectKey && l.componentId === componentId,
    );
    return entry?.layer ?? '';
  }

  /** Saves one mapping right away; `''` removes it (the component goes to "Sin capa"). */
  async setComponentLayer(projectKey: string, component: JiraComponent, layer: Layer | ''): Promise<void> {
    await this.#editor.apply((c) =>
      setComponentLayer(c, { projectKey, componentId: component.id, componentName: component.name }, layer || null),
    );
  }

  /** `''` removes the override: the status keeps the category Jira gives it. */
  setOverride(statusId: string, category: Category | ''): void {
    this.overrides.update((current) => {
      const next = { ...current };
      if (category === '') delete next[statusId];
      else next[statusId] = category;
      return next;
    });
  }

  async finish(): Promise<void> {
    if (await this.saveParticularities('Conexión configurada.')) this.mode.set('edit');
  }

  async saveParticularities(message = 'Particularidades guardadas.'): Promise<boolean> {
    this.saving.set(true);
    try {
      const result = await this.#editor.apply(
        (c) =>
          setJiraParticularities(c, {
            epicLinkMode: this.epicLinkMode(),
            epicLinkFieldId: this.epicLinkFieldId() || null,
            statusCategoryOverrides: this.overrides(),
          }),
        message,
      );
      return result.ok;
    } finally {
      this.saving.set(false);
    }
  }
}
