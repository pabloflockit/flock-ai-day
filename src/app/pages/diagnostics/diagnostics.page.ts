import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AppStore } from '../../core/store/app-store';

@Component({
  selector: 'app-diagnostics-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Diagnóstico</h1>
    <section>
      <h2>Servicio local</h2>
      @switch (health().status) {
        @case ('ok') {
          <p>Servicio local activo (versión {{ health().version }}).</p>
        }
        @case ('error') {
          <p role="alert">No se pudo conectar con el servicio local: {{ health().errorMessage }}</p>
        }
        @case ('checking') {
          <p>Verificando…</p>
        }
        @default {
          <p>Sin verificar.</p>
        }
      }
      <button type="button" (click)="recheck()">Verificar de nuevo</button>
    </section>
  `,
})
export class DiagnosticsPage {
  readonly #store = inject(AppStore);
  readonly health = this.#store.proxyHealth;

  constructor() {
    void this.#store.checkProxyHealth();
  }

  recheck(): void {
    void this.#store.checkProxyHealth();
  }
}
