import { afterNextRender, Component, ElementRef, inject, input, output } from '@angular/core';
import { Icon } from './icon';

let nextModalId = 1;

/**
 * Modal overlay — reference §5 "Overlays": head (title + close), body, foot (actions right).
 * Escape and backdrop clicks emit `closed`; the parent decides what closing means.
 */
@Component({
  selector: 'app-modal',
  imports: [Icon],
  template: `
    <div class="modal-backdrop" (click)="closed.emit()">
      <div
        class="modal"
        [class.modal-wide]="wide()"
        role="dialog"
        aria-modal="true"
        [attr.aria-labelledby]="titleId"
        (click)="$event.stopPropagation()"
        (keydown.escape)="closed.emit()"
      >
        <header class="modal-head">
          <h2 [id]="titleId">{{ title() }}</h2>
          <button type="button" class="btn-icon" aria-label="Cerrar" (click)="closed.emit()">
            <app-icon name="close" />
          </button>
        </header>
        <div class="modal-body"><ng-content /></div>
        <footer class="modal-foot"><ng-content select="[modal-actions]" /></footer>
      </div>
    </div>
  `,
})
export class Modal {
  readonly title = input.required<string>();
  /** Wide variant for tables (drill-down lists). */
  readonly wide = input(false);
  readonly closed = output<void>();
  protected readonly titleId = `modal-title-${nextModalId++}`;

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef);
    afterNextRender(() => {
      const target = host.nativeElement.querySelector<HTMLElement>(
        '.modal-body input, .modal-body select, .modal-body textarea, .modal-foot button',
      );
      target?.focus();
    });
  }
}
