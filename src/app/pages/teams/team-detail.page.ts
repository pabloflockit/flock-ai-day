import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  addProject,
  removeMember,
  removeProject,
  setMemberActive,
  updateProject,
} from '../../../../shared/config-edit.mjs';
import { initials, userSearchHits } from '../../../../shared/config-view.mjs';
import { ConfigEditor } from '../../core/config-editor';
import { AppStore } from '../../core/store/app-store';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Icon } from '../../shared/ui/icon';
import { Modal } from '../../shared/ui/modal';
import { measureSummary } from '../projects/measure-summary';
import { addJiraUser, MemberSearch, type JiraUserHit } from './member-search';

type Tab = 'members' | 'projects';

/** Team detail (plan §6.1.3): members with the Jira search, and the team's projects (create, activate, delete). */
@Component({
  selector: 'app-team-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MemberSearch, Modal, Icon],
  templateUrl: './team-detail.page.html',
  styleUrl: './team-detail.page.scss',
})
export class TeamDetailPage {
  readonly #store = inject(AppStore);
  readonly #editor = inject(ConfigEditor);
  readonly #confirm = inject(ConfirmService);
  readonly #params = toSignal(inject(ActivatedRoute).paramMap);

  readonly initials = initials;
  readonly measureSummary = measureSummary;
  readonly configState = this.#store.configState;
  readonly tab = signal<Tab>('members');

  readonly teamId = computed(() => this.#params()?.get('id') ?? '');
  readonly team = computed(() => this.#store.config()?.teams.find((t) => t.id === this.teamId()) ?? null);
  readonly projects = computed(() => this.#store.config()?.projects.filter((p) => p.teamId === this.teamId()) ?? []);
  /** The other teams each member belongs to, by account id. */
  readonly otherTeams = computed(() => {
    const config = this.#store.config();
    const team = this.team();
    const result = new Map<string, string[]>();
    if (!config || !team) return result;
    const hits = userSearchHits(
      config,
      team.id,
      team.members.map((m) => ({ accountId: m.accountId, displayName: m.displayName, emailAddress: m.emailAddress })),
    );
    for (const hit of hits) result.set(hit.user.accountId, hit.otherTeams);
    return result;
  });

  readonly projectForm = signal(false);
  readonly projectName = signal('');
  readonly projectDescription = signal('');
  readonly nameError = signal<string | null>(null);
  readonly formError = signal<string | null>(null);
  readonly saving = signal(false);
  readonly deleteError = signal<string | null>(null);

  constructor() {
    void this.#store.loadConfig();
    void this.#store.loadConnectionStatus();
  }

  openProjectForm(): void {
    this.projectName.set('');
    this.projectDescription.set('');
    this.nameError.set(null);
    this.formError.set(null);
    this.projectForm.set(true);
  }

  closeProjectForm(): void {
    this.projectForm.set(false);
  }

  async createProject(): Promise<void> {
    if (this.saving()) return;
    const teamId = this.teamId();
    const name = this.projectName();
    const description = this.projectDescription();
    this.saving.set(true);
    this.nameError.set(null);
    this.formError.set(null);
    try {
      const result = await this.#editor.apply(
        (c) => addProject(c, { id: crypto.randomUUID(), teamId, name, description }),
        'Proyecto creado.',
      );
      if (result.ok) {
        this.projectForm.set(false);
        return;
      }
      this.nameError.set(result.issues.find((i) => i.path === 'name')?.message ?? null);
      this.formError.set(result.issues.find((i) => i.path !== 'name')?.message ?? null);
    } finally {
      this.saving.set(false);
    }
  }

  async toggleProject(id: string, active: boolean): Promise<void> {
    await this.#editor.apply((c) => updateProject(c, id, { active }), active ? 'Proyecto activado.' : 'Proyecto desactivado.');
  }

  async removeProject(id: string, name: string): Promise<void> {
    const config = this.#store.config();
    if (!config) return;
    this.deleteError.set(null);
    const guard = removeProject(config, id);
    if (!guard.ok) {
      this.deleteError.set(guard.issues[0]?.message ?? 'No se puede eliminar el proyecto.');
      return;
    }
    const accepted = await this.#confirm.ask({
      title: 'Eliminar proyecto',
      message: `¿Eliminar el proyecto "${name}"?`,
      confirmLabel: 'Eliminar',
    });
    if (accepted) await this.#editor.apply((c) => removeProject(c, id), 'Proyecto eliminado.');
  }

  async addMember(user: JiraUserHit): Promise<void> {
    const teamId = this.teamId();
    await this.#editor.apply(addJiraUser(teamId, user), 'Integrante agregado.');
  }

  async toggleMember(accountId: string, active: boolean): Promise<void> {
    const teamId = this.teamId();
    await this.#editor.apply(
      (c) => setMemberActive(c, teamId, accountId, active),
      active ? 'Integrante activado.' : 'Integrante desactivado.',
    );
  }

  async removeMember(accountId: string, name: string): Promise<void> {
    const teamId = this.teamId();
    const accepted = await this.#confirm.ask({
      title: 'Quitar integrante',
      message: `¿Quitar a ${name} del equipo?`,
      confirmLabel: 'Quitar',
    });
    if (accepted) await this.#editor.apply((c) => removeMember(c, teamId, accountId), 'Integrante quitado.');
  }
}
