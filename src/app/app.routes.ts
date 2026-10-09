import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'diagnostics' },
  {
    path: 'diagnostics',
    loadComponent: () =>
      import('./pages/diagnostics/diagnostics.page').then((m) => m.DiagnosticsPage),
  },
  { path: '**', redirectTo: 'diagnostics' },
];
