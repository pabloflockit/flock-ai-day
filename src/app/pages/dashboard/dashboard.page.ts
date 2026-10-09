import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { setMemberActive } from '../../../../shared/config-edit.mjs';
import { ConfigEditor } from '../../core/config-editor';
import { AppStore } from '../../core/store/app-store';
import { InstantPipe } from '../../shared/pipes/instant.pipe';
import { type Drill, UnitListModal } from '../../shared/ui/unit-list-modal';
import { AddMemberModal } from './add-member-modal';
import { DashboardGroupView } from './dashboard-group';
import { DashboardOutside, type OutsidePerson } from './dashboard-outside';
import { DashboardState } from './dashboard.state';
import { type ReportKind, ReportsModal } from './reports-modal';

/** Team dashboard (plan §6.2): team -> project -> epic selectors over the cached `projectIssues` data. */
@Component({
  selector: 'app-dashboard-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, InstantPipe, DashboardGroupView, DashboardOutside, UnitListModal, AddMemberModal, ReportsModal],
  providers: [DashboardState],
  templateUrl: './dashboard.page.html',
  styleUrl: './dashboard.page.scss',
})
export class DashboardPage {
  readonly #store = inject(AppStore);
  readonly #editor = inject(ConfigEditor);
  readonly state = inject(DashboardState);
  readonly configState = this.#store.configState;

  /** The drill-down currently open, if any (reused by every number of the page). */
  readonly drill = signal<Drill | null>(null);

  /** Team view or "Fuera del equipo"; switching is a pure view change over the same loaded data. */
  readonly view = signal<'team' | 'outside'>('team');
  /** Report modal currently open, if any. */
  readonly report = signal<ReportKind | null>(null);
  /** Person whose "Agregar al equipo" flow is open. */
  readonly adding = signal<OutsidePerson | null>(null);

  constructor() {
    void this.#store.loadConfig();
    void this.#store.loadConnectionStatus();
  }

  selectTeam(id: string): void {
    this.state.teamId.set(id);
  }

  selectProject(id: string): void {
    this.state.projectId.set(id || null);
  }

  selectEpic(key: string): void {
    this.state.epicKey.set(key || null);
  }

  async reactivate(person: OutsidePerson): Promise<void> {
    const teamId = this.state.teamId();
    if (!teamId) return;
    await this.#editor.apply((c) => setMemberActive(c, teamId, person.accountId, true), 'Integrante activado.');
  }
}
