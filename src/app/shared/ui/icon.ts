import { Component, computed, input } from '@angular/core';

/**
 * Line icons — reference §4: 24 px grid, stroke-width 1.7, round caps and joins,
 * fill none, `currentColor`. Drawn in-house; no external icon library.
 */
const PATHS = {
  close: ['M6 6l12 12', 'M18 6L6 18'],
  plus: ['M12 5v14', 'M5 12h14'],
  dots: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  alert: ['M12 4l9 16H3z', 'M12 10v4', 'M12 17h.01'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  move: ['M4 12h16', 'M16 8l4 4-4 4', 'M8 8l-4 4 4 4'],
  team: [
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    'M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6',
    'M16 4.5a3.5 3.5 0 0 1 0 6.5',
    'M18 14c1.8.8 3 2.6 3 4.7',
  ],
  progress: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  sliders: ['M4 6h9', 'M17 6h3', 'M15 4v4', 'M4 12h3', 'M11 12h9', 'M9 10v4', 'M4 18h11', 'M19 18h1', 'M17 16v4'],
  sync: ['M20 11a8 8 0 0 0-14.3-4.9L4 8', 'M4 4v4h4', 'M4 13a8 8 0 0 0 14.3 4.9L20 16', 'M20 20v-4h-4'],
  moon: ['M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'],
  sun: [
    'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4',
    'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4',
  ],
  'shield-check': ['M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z', 'M8.5 12l2.5 2.5 4.5-5'],
} as const;

export type IconName = keyof typeof PATHS;

@Component({
  selector: 'app-icon',
  host: { class: 'icon', 'aria-hidden': 'true' },
  template: `
    <svg
      viewBox="0 0 24 24"
      [attr.width]="size()"
      [attr.height]="size()"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      @for (d of paths(); track $index) {
        <path [attr.d]="d" />
      }
    </svg>
  `,
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input(18);
  protected readonly paths = computed(() => PATHS[this.name()]);
}
