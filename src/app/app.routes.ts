import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'connection' },
  {
    path: 'connection',
    loadComponent: () =>
      import('./pages/connection/connection.page').then((m) => m.ConnectionPage),
  },
  {
    path: 'diagnostics',
    loadComponent: () =>
      import('./pages/diagnostics/diagnostics.page').then((m) => m.DiagnosticsPage),
  },
  {
    path: 'teams',
    loadComponent: () => import('./pages/teams/teams.page').then((m) => m.TeamsPage),
  },
  {
    path: 'teams/:id',
    loadComponent: () => import('./pages/teams/team-detail.page').then((m) => m.TeamDetailPage),
  },
  {
    path: 'projects/:id',
    loadComponent: () =>
      import('./pages/projects/project-detail.page').then((m) => m.ProjectDetailPage),
  },
  {
    path: 'sync',
    loadComponent: () => import('./pages/sync/sync.page').then((m) => m.SyncPage),
  },
  {
    path: 'settings',
    loadComponent: () => import('./pages/settings/settings.page').then((m) => m.SettingsPage),
  },
  { path: '**', redirectTo: 'connection' },
];
