import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { THEME_STORAGE_KEY, ThemeService } from './theme.service';

describe('ThemeService', () => {
  const html = document.documentElement;

  function create() {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    return TestBed.inject(ThemeService);
  }

  afterEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    html.classList.remove('dark');
  });

  it('is dark by default', () => {
    const theme = create();
    expect(theme.theme()).toBe('dark');
    expect(html.classList.contains('dark')).toBeTrue();
  });

  it('restores the stored choice', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    html.classList.add('dark');
    const theme = create();
    expect(theme.theme()).toBe('light');
    expect(html.classList.contains('dark')).toBeFalse();
  });

  it('toggles, applies the class and remembers it', () => {
    const theme = create();
    theme.toggle();
    expect(theme.theme()).toBe('light');
    expect(html.classList.contains('dark')).toBeFalse();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    theme.toggle();
    expect(html.classList.contains('dark')).toBeTrue();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('ignores an unknown stored value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(create().theme()).toBe('dark');
  });
});
