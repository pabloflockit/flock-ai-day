import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { NAV_SECTIONS } from './shell/nav';

describe('App shell', () => {
  async function render() {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('renders the dark brand sidebar with the white mark', async () => {
    const el = await render();
    const sidebar = el.querySelector('nav.sidebar');
    expect(sidebar).not.toBeNull();
    expect(sidebar?.querySelector('img')?.getAttribute('src')).toBe('brand/flock-mark-white.svg');
  });

  it('renders one link per navigation item', async () => {
    const el = await render();
    const expected = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.label));
    const labels = Array.from(el.querySelectorAll('nav.sidebar a')).map((a) => a.textContent?.trim());
    expect(labels).toEqual(expected);
  });

  it('hosts the toast and confirm overlays', async () => {
    const el = await render();
    expect(el.querySelector('app-toast-host')).not.toBeNull();
    expect(el.querySelector('app-confirm-host')).not.toBeNull();
  });
});
