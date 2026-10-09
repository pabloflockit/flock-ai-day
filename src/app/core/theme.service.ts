import { DOCUMENT, inject, Injectable, signal } from '@angular/core';

export type Theme = 'dark' | 'light';

/** Per-device UI preference; it is not part of the shared configuration. */
export const THEME_STORAGE_KEY = 'leadership-panel.theme';

function storedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/**
 * Light/dark theme (Flock Design System §7: `html.dark`). Dark is the default; `index.html`
 * already starts with `class="dark"` so the default never flashes light before boot.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly #root = inject(DOCUMENT).documentElement;
  readonly theme = signal<Theme>(storedTheme());

  constructor() {
    this.#apply(this.theme());
  }

  toggle(): void {
    this.set(this.theme() === 'dark' ? 'light' : 'dark');
  }

  set(theme: Theme): void {
    this.theme.set(theme);
    this.#apply(theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Storage unavailable: the choice lasts for this session only.
    }
  }

  #apply(theme: Theme): void {
    this.#root.classList.toggle('dark', theme === 'dark');
  }
}
