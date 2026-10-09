import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ThemeService } from './core/theme.service';
import { ConfirmHost } from './shared/ui/confirm-host';
import { Icon } from './shared/ui/icon';
import { ToastHost } from './shared/ui/toast-host';
import { NAV_SECTIONS } from './shell/nav';

/** App shell: dark brand sidebar (reference §7) + content canvas + global overlays. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, ToastHost, ConfirmHost],
  template: `
    <div class="app-shell">
      <nav class="sidebar" aria-label="Navegación principal">
        <div class="sidebar-brand">
          <img src="brand/flock-mark-white.svg" alt="" width="28" height="28" />
          <span>Panel de Liderazgo</span>
        </div>
        @for (section of sections; track section.title) {
          <p class="sidebar-section">{{ section.title }}</p>
          @for (item of section.items; track item.path) {
            <a class="sidebar-link" [routerLink]="item.path" routerLinkActive="active">
              <app-icon [name]="item.icon" />
              <span>{{ item.label }}</span>
            </a>
          }
        }
        <div class="sidebar-foot">
          <button
            type="button"
            class="sidebar-switch"
            role="switch"
            [attr.aria-checked]="theme.theme() === 'dark'"
            (click)="theme.toggle()"
          >
            <app-icon [name]="theme.theme() === 'dark' ? 'moon' : 'sun'" />
            <span>Modo oscuro</span>
            <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
          </button>
        </div>
      </nav>
      <main class="app-main">
        <router-outlet />
      </main>
    </div>
    <app-toast-host />
    <app-confirm-host />
  `,
})
export class App {
  protected readonly sections = NAV_SECTIONS;
  protected readonly theme = inject(ThemeService);
}
