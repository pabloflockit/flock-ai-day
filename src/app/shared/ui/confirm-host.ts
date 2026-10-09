import { Component, inject } from '@angular/core';
import { ConfirmService } from './confirm.service';
import { Modal } from './modal';

/** Renders the pending `ConfirmService` request. Mounted once by the app shell. */
@Component({
  selector: 'app-confirm-host',
  imports: [Modal],
  template: `
    @if (confirm.pending(); as request) {
      <app-modal [title]="request.title" (closed)="confirm.answer(false)">
        <p>{{ request.message }}</p>
        <ng-container modal-actions>
          <button type="button" class="btn-ghost" (click)="confirm.answer(false)">{{ request.cancelLabel }}</button>
          <button type="button" (click)="confirm.answer(true)">{{ request.confirmLabel }}</button>
        </ng-container>
      </app-modal>
    }
  `,
})
export class ConfirmHost {
  protected readonly confirm = inject(ConfirmService);
}
