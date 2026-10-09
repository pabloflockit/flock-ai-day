import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, linkedSignal, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { AppConfig } from '../../../../proxy/config/normalize.mjs';
import {
  addEpic,
  moveEpic,
  reassignProject,
  removeEpic,
  removeProject,
  setEpicActive,
  updateProject,
} from '../../../../shared/config-edit.mjs';
import { epicSyncRows, measureFields } from '../../../../shared/config-view.mjs';
import { ConfigEditor } from '../../core/config-editor';
import { errorMessageEs } from '../../core/error-messages';
import { idle, toOpError, track, type Op } from '../../core/op';
import { ProxyClient } from '../../core/proxy-client';
import { AppStore } from '../../core/store/app-store';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Modal } from '../../shared/ui/modal';

type Project = AppConfig['projects'][number];
type Measure = Project['measure'];
type WorkUnit = Project['workUnit'];
type MeasureKind = Measure['kind'];

interface JiraField {
  id: string;
  name: string;
  custom: boolean;
  schema: { type: string | null };
}

interface EpicInfo {
  key: string;
  summary: string;
  issueTypeId: string;
}

interface ProjectDataset {
  fetchedAt: string | null;
  shardsMeta: { key: string; status: 'ok' | 'failed'; lastOkAt: string | null; errorCode?: string | null }[];
}

const UNITS: { value: WorkUnit; label: string }[] = [
  { value: 'task', label: 'Tarea' },
  { value: 'subtask', label: 'Subtarea' },
  { value: 'both', label: 'Ambas' },
];

/** Project detail (plan §6.1.4/§6.1.5): edit, team, measurement and epics with their sync state. */
@Component({
  selector: 'app-project-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Modal],
  templateUrl: './project-detail.page.html',
  styleUrl: './project-detail.page.scss',
})
export class ProjectDetailPage {
  readonly #store = inject(AppStore);
  readonly #editor = inject(ConfigEditor);
  readonly #confirm = inject(ConfirmService);
  readonly #proxy = inject(ProxyClient);
  readonly #router = inject(Router);
  readonly #params = toSignal(inject(ActivatedRoute).paramMap);
  #destroyed = false;
  #datasetLoad = 0;

  readonly units = UNITS;
  readonly configState = this.#store.configState;
  readonly jiraReady = this.#store.jiraReady;

  readonly projectId = computed(() => this.#params()?.get('id') ?? '');
  readonly project = computed(() => this.#store.config()?.projects.find((p) => p.id === this.projectId()) ?? null);
  readonly team = computed(() => this.#store.config()?.teams.find((t) => t.id === this.project()?.teamId) ?? null);
  readonly otherTeams = computed(() => this.#store.config()?.teams.filter((t) => t.id !== this.project()?.teamId) ?? []);
  readonly otherProjects = computed(() => this.#store.config()?.projects.filter((p) => p.id !== this.projectId()) ?? []);

  // Edit modal
  readonly editing = signal(false);
  readonly name = signal('');
  readonly description = signal('');
  readonly nameError = signal<string | null>(null);
  readonly formError = signal<string | null>(null);
  readonly saving = signal(false);

  readonly targetTeamId = signal('');
  readonly deleteError = signal<string | null>(null);

  // Measurement draft, reset whenever the saved project changes
  readonly unit = linkedSignal<WorkUnit>(() => this.project()?.workUnit ?? 'task');
  readonly measureKind = linkedSignal<MeasureKind>(() => this.project()?.measure.kind ?? 'count');
  readonly fieldId = linkedSignal(() => {
    const measure = this.project()?.measure;
    return measure?.kind === 'field' ? measure.fieldId : '';
  });
  readonly fields = signal<Op<JiraField[]>>(idle());
  /** Numeric fields, plus the saved one when Jira did not list it (so the select never looks empty). */
  readonly fieldOptions = computed(() => {
    const options = measureFields(this.fields().data ?? []);
    const saved = this.project()?.measure;
    if (saved?.kind === 'field' && !options.some((o) => o.fieldId === saved.fieldId)) {
      options.unshift({ fieldId: saved.fieldId, fieldName: saved.fieldName, valueType: saved.valueType });
    }
    return options;
  });
  readonly canSaveMeasure = computed(
    () => this.measureKind() === 'count' || this.fieldOptions().some((o) => o.fieldId === this.fieldId()),
  );

  // Epics
  readonly dataset = signal<Op<ProjectDataset>>(idle());
  readonly epicKey = signal('');
  readonly epicError = signal<string | null>(null);
  readonly addingEpic = signal(false);
  readonly moveTargets = signal<Record<string, string>>({});
  readonly epicRows = computed(() => {
    const project = this.project();
    return project ? epicSyncRows(project, this.dataset().data?.shardsMeta ?? []) : [];
  });
  readonly hasSyncData = computed(() => this.dataset().status === 'ok' && this.dataset().data?.fetchedAt != null);

  constructor() {
    inject(DestroyRef).onDestroy(() => (this.#destroyed = true));
    void this.#store.loadConfig();
    void this.#store.loadConnectionStatus();

    effect(() => {
      const id = this.projectId();
      if (id) untracked(() => void this.#loadDataset(id));
    });
    // The fields list is only needed (and only fetched) when measuring by a Jira field.
    effect(() => {
      if (this.measureKind() === 'field' && this.jiraReady() && untracked(this.fields).status === 'idle') {
        untracked(() => void track(this.fields, () => this.#proxy.get<JiraField[]>('/api/jira/fields')));
      }
    });
  }

  formatDate(iso: string | null): string {
    return iso ? new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  }

  syncErrorMessage(code: string | null): string {
    return errorMessageEs(code ?? 'UNKNOWN');
  }

  linkMethodLabel(method: 'parent' | 'epic_link' | null): string {
    return method === 'parent' ? 'Parent' : method === 'epic_link' ? 'Epic Link' : 'Sin detectar';
  }

  // ---- Project -------------------------------------------------------------------------------

  openEdit(): void {
    const project = this.project();
    if (!project) return;
    this.name.set(project.name);
    this.description.set(project.description ?? '');
    this.nameError.set(null);
    this.formError.set(null);
    this.editing.set(true);
  }

  closeEdit(): void {
    this.editing.set(false);
  }

  async submit(): Promise<void> {
    const id = this.projectId();
    if (!this.editing() || this.saving()) return;
    const name = this.name();
    const description = this.description();
    this.saving.set(true);
    this.nameError.set(null);
    this.formError.set(null);
    try {
      const result = await this.#editor.apply((c) => updateProject(c, id, { name, description }), 'Proyecto actualizado.');
      if (result.ok) {
        this.editing.set(false);
        return;
      }
      this.nameError.set(result.issues.find((i) => i.path === 'name')?.message ?? null);
      this.formError.set(result.issues.find((i) => i.path !== 'name')?.message ?? null);
    } finally {
      this.saving.set(false);
    }
  }

  async toggleActive(active: boolean): Promise<void> {
    const id = this.projectId();
    await this.#editor.apply((c) => updateProject(c, id, { active }), active ? 'Proyecto activado.' : 'Proyecto desactivado.');
  }

  async reassign(): Promise<void> {
    const id = this.projectId();
    const project = this.project();
    const target = this.otherTeams().find((t) => t.id === this.targetTeamId());
    if (!project || !target) return;
    const accepted = await this.#confirm.ask({
      title: 'Cambiar de equipo',
      message: `¿Pasar el proyecto "${project.name}" al equipo "${target.name}"?`,
      confirmLabel: 'Cambiar',
    });
    if (!accepted) return;
    const result = await this.#editor.apply((c) => reassignProject(c, id, target.id), 'Proyecto movido de equipo.');
    if (result.ok) this.targetTeamId.set('');
  }

  async remove(): Promise<void> {
    const id = this.projectId();
    const project = this.project();
    const config = this.#store.config();
    if (!project || !config) return;
    const teamId = project.teamId;
    this.deleteError.set(null);
    const guard = removeProject(config, id);
    if (!guard.ok) {
      this.deleteError.set(guard.issues[0]?.message ?? 'No se puede eliminar el proyecto.');
      return;
    }
    const accepted = await this.#confirm.ask({
      title: 'Eliminar proyecto',
      message: `¿Eliminar el proyecto "${project.name}"?`,
      confirmLabel: 'Eliminar',
    });
    if (!accepted) return;
    const result = await this.#editor.apply((c) => removeProject(c, id), 'Proyecto eliminado.');
    if (result.ok) void this.#router.navigate(['/teams', teamId]);
  }

  // ---- Measurement ---------------------------------------------------------------------------

  async saveMeasure(): Promise<void> {
    const id = this.projectId();
    const workUnit = this.unit();
    let measure: Measure = { kind: 'count' };
    if (this.measureKind() === 'field') {
      const option = this.fieldOptions().find((o) => o.fieldId === this.fieldId());
      if (!option) return;
      measure = { kind: 'field', ...option };
    }
    await this.#editor.apply((c) => updateProject(c, id, { workUnit, measure }), 'Medición guardada.');
  }

  // ---- Epics ---------------------------------------------------------------------------------

  async addEpic(): Promise<void> {
    const key = this.epicKey().trim().toUpperCase();
    const projectId = this.projectId();
    if (!key || this.addingEpic() || !this.jiraReady()) return;
    this.addingEpic.set(true);
    this.epicError.set(null);
    try {
      let info: EpicInfo;
      try {
        info = await this.#proxy.get<EpicInfo>(`/api/jira/epics/${encodeURIComponent(key)}`);
      } catch (error) {
        if (this.#isCurrent(key)) this.epicError.set(toOpError(error).message);
        return;
      }
      // The user kept typing (or left) while Jira answered: this result belongs to another key.
      if (!this.#isCurrent(key)) return;

      const epic = { key, issueTypeId: info.issueTypeId, summary: info.summary };
      const config = this.#store.config();
      const probe = config ? addEpic(config, projectId, epic) : null;
      const ownerId =
        probe && !probe.ok ? probe.issues.find((i) => i.code === 'EPIC_OWNED_BY_OTHER_PROJECT')?.ownerProjectId : undefined;
      if (ownerId) {
        await this.#moveHere(key, ownerId);
        return;
      }
      const result = await this.#editor.apply((c) => addEpic(c, projectId, epic), 'Épica agregada.');
      if (result.ok) this.epicKey.set('');
      else this.epicError.set(result.issues[0]?.message ?? null);
    } finally {
      this.addingEpic.set(false);
    }
  }

  async toggleEpic(key: string, active: boolean): Promise<void> {
    const id = this.projectId();
    await this.#editor.apply((c) => setEpicActive(c, id, key, active), active ? 'Épica activada.' : 'Épica desactivada.');
  }

  setMoveTarget(key: string, projectId: string): void {
    this.moveTargets.update((targets) => ({ ...targets, [key]: projectId }));
  }

  async moveEpic(key: string): Promise<void> {
    const target = this.moveTargets()[key];
    if (!target) return;
    const result = await this.#editor.apply((c) => moveEpic(c, key, target), 'Épica movida.');
    if (result.ok) this.setMoveTarget(key, '');
  }

  async removeEpic(key: string): Promise<void> {
    const id = this.projectId();
    const accepted = await this.#confirm.ask({
      title: 'Quitar épica',
      message: `¿Quitar la épica ${key} del proyecto?`,
      confirmLabel: 'Quitar',
    });
    if (accepted) await this.#editor.apply((c) => removeEpic(c, id, key), 'Épica quitada.');
  }

  async #moveHere(key: string, ownerId: string): Promise<void> {
    const owner = this.#store.config()?.projects.find((p) => p.id === ownerId);
    const here = this.project();
    if (!here) return;
    const accepted = await this.#confirm.ask({
      title: 'Mover épica',
      message: `La épica ${key} ya pertenece al proyecto "${owner?.name ?? ''}". ¿Moverla a "${here.name}"?`,
      confirmLabel: 'Mover',
    });
    if (!accepted) return;
    const result = await this.#editor.apply((c) => moveEpic(c, key, here.id), 'Épica movida.');
    if (result.ok) this.epicKey.set('');
  }

  #isCurrent(key: string): boolean {
    return !this.#destroyed && this.epicKey().trim().toUpperCase() === key;
  }

  async #loadDataset(projectId: string): Promise<void> {
    const load = ++this.#datasetLoad;
    const target = signal<Op<ProjectDataset>>(idle());
    this.dataset.set({ status: 'loading', data: null, error: null });
    await track(target, () =>
      this.#proxy.get<ProjectDataset>(`/api/datasets/projectIssues?scopeId=${encodeURIComponent(projectId)}`),
    );
    // A newer load (another project) or a destroyed page makes this answer stale.
    if (load === this.#datasetLoad && !this.#destroyed) this.dataset.set(target());
  }
}
