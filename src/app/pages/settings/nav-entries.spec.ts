import { NAV_SECTIONS } from '../../shell/nav';
import { routes } from '../../app.routes';

describe('Administration navigation', () => {
  const admin = NAV_SECTIONS.find((s) => s.title === 'Administración')!;

  it('lists sync and settings between Equipos and Diagnóstico, in that order', () => {
    expect(admin.items.map((i) => [i.label, i.path])).toEqual([
      ['Conexión', '/connection'],
      ['Equipos', '/teams'],
      ['Sincronización', '/sync'],
      ['Configuración', '/settings'],
      ['Diagnóstico', '/diagnostics'],
    ]);
  });

  it('has a lazy route for every navigation item', () => {
    for (const item of admin.items) {
      const route = routes.find((r) => `/${r.path}` === item.path);
      expect(route?.loadComponent).withContext(item.path).toEqual(jasmine.any(Function));
    }
  });
});
