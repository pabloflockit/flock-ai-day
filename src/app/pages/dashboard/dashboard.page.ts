import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AppStore } from '../../core/store/app-store';
import { InstantPipe } from '../../shared/pipes/instant.pipe';
import { DashboardState } from './dashboard.state';

/** Team dashboard (plan §6.2): team -> project -> epic selectors over the cached `projectIssues` data. */
@Component({
  selector: 'app-dashboard-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, InstantPipe],
  providers: [DashboardState],
  templateUrl: './dashboard.page.html',
  styleUrl: './dashboard.page.scss',
})
export class DashboardPage {
  readonly #store = inject(AppStore);
  readonly state = inject(DashboardState);
  readonly configState = this.#store.configState;

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
