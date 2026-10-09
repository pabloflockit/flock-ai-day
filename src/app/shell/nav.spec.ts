import { routes } from '../app.routes';
import { NAV_SECTIONS } from './nav';

describe('sprint close navigation', () => {
  it('lists "Cierre de sprint" right after the dashboard', () => {
    const items = NAV_SECTIONS[0].items;
    expect(items.map((i) => i.label)).toEqual(['Dashboard', 'Cierre de sprint']);
    expect(items[1].path).toBe('/sprint-close');
  });

  it('has a lazy route for it', () => {
    const route = routes.find((r) => r.path === 'sprint-close');
    expect(route?.loadComponent).toBeDefined();
  });
});
