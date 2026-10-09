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
  { path: '**', redirectTo: 'connection' },
];
