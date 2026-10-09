import { Component, inject } from '@angular/core';
import { ToastService } from './toast.service';

/** Renders active toasts — reference §5 "Overlays": fixed bottom-center. Mounted once by the shell. */
@Component({
  selector: 'app-toast-host',
  template: `
    <div class="toast-stack" aria-live="polite">
      @for (toast of toasts.toasts(); track toast.id) {
        <div class="toast" [class]="'toast-' + toast.kind" [attr.role]="toast.kind === 'error' ? 'alert' : 'status'">
          <span class="toast-dot" aria-hidden="true"></span>
          <span>{{ toast.message }}</span>
          <button type="button" class="btn-light toast-close" aria-label="Cerrar aviso" (click)="toasts.dismiss(toast.id)">×</button>
        </div>
      }
    </div>
  `,
})
export class ToastHost {
  protected readonly toasts = inject(ToastService);
}
