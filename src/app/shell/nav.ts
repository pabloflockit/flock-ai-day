import type { IconName } from '../shared/ui/icon';

export interface NavItem {
  label: string;
  path: string;
  icon: IconName;
}

export interface NavSection {
  title: string;
  items: readonly NavItem[];
}

/** Sidebar navigation. Items are added as their screens land (odd/tasks/flow2-phase-a.md). */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    title: 'Panel',
    items: [{ label: 'Dashboard', path: '/dashboard', icon: 'progress' }],
  },
  {
    title: 'Administración',
    items: [
      { label: 'Conexión', path: '/connection', icon: 'link' },
      { label: 'Equipos', path: '/teams', icon: 'team' },
      { label: 'Sincronización', path: '/sync', icon: 'sync' },
      { label: 'Configuración', path: '/settings', icon: 'sliders' },
      { label: 'Diagnóstico', path: '/diagnostics', icon: 'shield-check' },
    ],
  },
];
