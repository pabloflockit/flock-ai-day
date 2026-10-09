import { Injectable, computed, effect, inject, linkedSignal, untracked } from '@angular/core';
import type { AppConfig } from '../../../../proxy/config/normalize.mjs';
import {
  loadByMember,
  measureKeyOf,
  measurementGroups,
  progress,
  othersOpenByPerson,
  staleUnits,
  statusDistribution,
  unassignedOpen,
  weeklyThroughput,
  workInProgress,
} from '../../../../shared/domain/metrics.mjs';
import { teamOutside, teamScope } from '../../../../shared/domain/scope.mjs';
import { buildWorkUnits } from '../../../../shared/domain/work-units.mjs';
import { AppStore } from '../../core/store/app-store';

type Team = AppConfig['teams'][number];
type Project = AppConfig['projects'][number];
type Epic = Project['epics'][number];
type Units = ReturnType<typeof buildWorkUnits>['units'];

/**
 * View state and derived data of the dashboard (team -> project -> epic). Provided by the page.
 * Selecting a project or an epic filters in memory: only a team change loads datasets, and
 * loading never triggers a Jira sync (the user syncs from /sync).
 */
@Injectable()
export class DashboardState {
  readonly #store = inject(AppStore);

  /** Local calendar for weeks and business days; the domain never reads the environment. */
  readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  readonly config = this.#store.config;
  readonly activeTeams = computed<Team[]>(() => this.config()?.teams.filter((t) => t.active) ?? []);

  readonly teamId = linkedSignal<Team[], string | null>({
    source: this.activeTeams,
    computation: (teams, previous) =>
      teams.some((t) => t.id === previous?.value) ? previous!.value : (teams[0]?.id ?? null),
  });
  readonly team = computed(() => this.activeTeams().find((t) => t.id === this.teamId()) ?? null);
  /** Active projects of the selected team. */
  readonly projects = computed<Project[]>(
    () => this.config()?.projects.filter((p) => p.active && p.teamId === this.teamId()) ?? [],
  );

  readonly projectId = linkedSignal<Project[], string | null>({
    source: this.projects,
    computation: (projects, previous) =>
      projects.some((p) => p.id === previous?.value) ? previous!.value : null,
  });
  /** Active epics of the selected project, or of every project of the team. */
  readonly epics = computed<Epic[]>(() =>
    this.projects()
      .filter((p) => this.projectId() === null || p.id === this.projectId())
      .flatMap((p) => p.epics.filter((e) => e.active)),
  );
  readonly epicKey = linkedSignal<Epic[], string | null>({
    source: this.epics,
    computation: (epics, previous) => (epics.some((e) => e.key === previous?.value) ? previous!.value : null),
  });

  /** ISO instant used as "now" by the metrics; refreshed whenever the data it describes changes. */
  readonly now = linkedSignal<string | null, string>({
    source: () => this.dataAsOf(),
    computation: () => new Date().toISOString(),
  });

  readonly #datasets = computed(() => this.projects().map((p) => ({ project: p, dataset: this.#store.projectIssues(p.id) })));

  /** Projects of the team whose dataset was read and is empty because it was never synced. */
  readonly missingDatasets = computed(() =>
    this.#datasets()
      .filter(({ dataset }) => dataset.status === 'ready' && dataset.fetchedAt === null)
      .map(({ project }) => project),
  );
  readonly loading = computed(() => this.#datasets().some(({ dataset }) => dataset.status === 'loading'));
  readonly datasetErrors = computed(() =>
    this.#datasets().flatMap(({ project, dataset }) => (dataset.error ? [{ project, error: dataset.error }] : [])),
  );
  /** Oldest `fetchedAt` among the team's datasets that have data. */
  readonly dataAsOf = computed<string | null>(() => {
    const dates = this.#datasets().flatMap(({ dataset }) => (dataset.fetchedAt ? [dataset.fetchedAt] : []));
    return dates.length ? dates.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)) : null;
  });
  /** Some dataset has data but is not current (its last refresh failed or the query changed). */
  readonly notCurrent = computed(() =>
    this.#datasets().some(({ dataset }) => dataset.fetchedAt !== null && !dataset.isCurrent),
  );

  readonly #built = computed(() => {
    const config = this.config();
    if (!config) return [];
    return this.#datasets().map(({ project, dataset }) => buildWorkUnits(dataset.rows, project, config));
  });
  readonly units = computed<Units>(() => this.#built().flatMap((b) => b.units));
  readonly tasksWithoutSubtasks = computed<Units>(() => this.#built().flatMap((b) => b.tasksWithoutSubtasks));

  readonly #filter = (units: Units): Units => {
    const projectId = this.projectId();
    const epicKey = this.epicKey();
    return units.filter((u) => (projectId === null || u.projectId === projectId) && (epicKey === null || u.epicKey === epicKey));
  };

  readonly scoped = computed<Units>(() => {
    const config = this.config();
    const teamId = this.teamId();
    return config && teamId ? this.#filter(teamScope(this.units(), teamId, config)) : [];
  });
  /** Tasks without subtasks (plan §3) with the same team scope and project/epic filters as `scoped`. */
  readonly tasksWithoutSubtasksScoped = computed<Units>(() => {
    const config = this.config();
    const teamId = this.teamId();
    return config && teamId ? this.#filter(teamScope(this.tasksWithoutSubtasks(), teamId, config)) : [];
  });
  readonly outside = computed(() => {
    const config = this.config();
    const teamId = this.teamId();
    const outside = config && teamId ? teamOutside(this.units(), teamId, config) : { unassigned: [], others: [] };
    return { unassigned: this.#filter(outside.unassigned), others: this.#filter(outside.others) };
  });
  /**
   * F1 and F2 per measurement group (same grouping as the main view, so measures never mix).
   * People who are inactive members of the selected team are flagged to offer reactivation.
   */
  readonly outsideGroups = computed(() => {
    const { unassigned, others } = this.outside();
    const inactive = new Set(this.team()?.members.filter((m) => !m.active).map((m) => m.accountId));
    return measurementGroups([...unassigned, ...others], this.projects())
      .map((group) => {
        const split = {
          unassigned: group.units.filter((u) => u.assigneeAccountId === null),
          others: group.units.filter((u) => u.assigneeAccountId !== null),
        };
        return {
          ...group,
          unassigned: unassignedOpen(split),
          people: othersOpenByPerson(split).map((p) => ({ ...p, inactiveMember: inactive.has(p.accountId) })),
        };
      })
      .filter((g) => g.unassigned.count > 0 || g.people.length > 0);
  });
  readonly outsideOpenCount = computed(() => {
    const { unassigned, others } = this.outside();
    return [...unassigned, ...others].filter((u) => u.statusCategory !== 'done').length;
  });

  /** Metrics M1–M6 per measurement group (unit type + measure), never mixed across groups. */
  readonly groups = computed(() => {
    const config = this.config();
    const projects = this.projects();
    if (!config) return [];
    const members = this.team()?.members.filter((m) => m.active) ?? [];
    const clock = { now: this.now(), timeZone: this.timeZone };
    const withoutSubtasks = this.tasksWithoutSubtasksScoped();
    return measurementGroups(this.scoped(), projects).map((group) => ({
      ...group,
      // Only subtask groups report them, and only the tasks of the projects measured by this group.
      tasksWithoutSubtasks:
        group.unitType === 'subtask'
          ? withoutSubtasks.filter((t) => {
              const measure = projects.find((p) => p.id === t.projectId)?.measure;
              return !!measure && measureKeyOf(measure) === group.measureKey;
            })
          : [],
      progress: progress(group.units, projects),
      statusDistribution: statusDistribution(group.units),
      workInProgress: workInProgress(group.units, members),
      load: loadByMember(group.units, members),
      stale: staleUnits(group.units, config.settings.staleBusinessDays, clock),
      throughput: weeklyThroughput(group.units, clock),
    }));
  });

  constructor() {
    // Reads what the proxy holds for each project of the team; never refreshes from Jira.
    effect(() => {
      const ids = this.projects().map((p) => p.id);
      untracked(() => ids.forEach((id) => this.#store.ensureProjectIssues(id)));
    });
  }
}

export type DashboardGroup = DashboardState['groups'] extends () => (infer G)[] ? G : never;
export type OutsideGroup = DashboardState['outsideGroups'] extends () => (infer G)[] ? G : never;
