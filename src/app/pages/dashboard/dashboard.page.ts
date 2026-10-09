import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AppStore } from '../../core/store/app-store';
import { InstantPipe } from '../../shared/pipes/instant.pipe';
import { type Drill, UnitListModal } from '../../shared/ui/unit-list-modal';
import { DashboardGroupView } from './dashboard-group';
import { DashboardState } from './dashboard.state';

/** Team dashboard (plan §6.2): team -> project -> epic selectors over the cached `projectIssues` data. */
@Component({
  selector: 'app-dashboard-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, InstantPipe, DashboardGroupView, UnitListModal],
  providers: [DashboardState],
  templateUrl: './dashboard.page.html',
  styleUrl: './dashboard.page.scss',
})
export class DashboardPage {
  readonly #store = inject(AppStore);
  readonly state = inject(DashboardState);
  readonly configState = this.#store.configState;

  /** The drill-down currently open, if any (reused by every number of the page). */
  readonly drill = signal<Drill | null>(null);

  constructor() {
    void this.#store.loadConfig();
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
}
