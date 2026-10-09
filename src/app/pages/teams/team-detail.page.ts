import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { addMember, removeMember, setMemberActive } from '../../../../shared/config-edit.mjs';
import { initials, userSearchHits } from '../../../../shared/config-view.mjs';
import { ConfigEditor } from '../../core/config-editor';
import { AppStore } from '../../core/store/app-store';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { MemberSearch, type JiraUserHit } from './member-search';

type Tab = 'members' | 'projects';

/** Team detail (plan §6.1.3): members with the Jira search, and the team's projects (read-only). */
@Component({
  selector: 'app-team-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MemberSearch],
  templateUrl: './team-detail.page.html',
  styleUrl: './team-detail.page.scss',
})
export class TeamDetailPage {
  readonly #store = inject(AppStore);
  readonly #editor = inject(ConfigEditor);
  readonly #confirm = inject(ConfirmService);
  readonly #params = toSignal(inject(ActivatedRoute).paramMap);

  readonly initials = initials;
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

  constructor() {
    void this.#store.loadConfig();
    void this.#store.loadConnectionStatus();
  }

  async addMember(user: JiraUserHit): Promise<void> {
    const teamId = this.teamId();
    await this.#editor.apply(
      (c) =>
        addMember(
          c,
          teamId,
          { accountId: user.accountId, displayName: user.displayName, emailAddress: user.emailAddress, active: user.active ?? true },
          new Date().toISOString(),
        ),
      'Integrante agregado.',
    );
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
