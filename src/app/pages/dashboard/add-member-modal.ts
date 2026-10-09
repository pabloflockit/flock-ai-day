import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { ConfigEditor } from '../../core/config-editor';
import { Modal } from '../../shared/ui/modal';
import { addJiraUser, type JiraUserHit, MemberSearch } from '../teams/member-search';

/**
 * "Agregar al equipo" from the outside view: the team's member search preloaded with the person's
 * name. Adding uses the same config op as the team screen; the member data comes from Jira's result.
 */
@Component({
  selector: 'app-add-member-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal, MemberSearch],
  template: `
    <app-modal title="Agregar al equipo" (closed)="closed.emit()">
      <app-member-search [teamId]="teamId()" [initialQuery]="query()" (add)="add($event)" />
      <button modal-actions type="button" (click)="closed.emit()">Cerrar</button>
    </app-modal>
  `,
})
export class AddMemberModal {
  readonly #editor = inject(ConfigEditor);

  readonly teamId = input.required<string>();
  /** Display name of the person from the issue row; only a search term, never member data. */
  readonly query = input.required<string>();
  readonly closed = output<void>();
  readonly saving = signal(false);

  async add(user: JiraUserHit): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    try {
      const result = await this.#editor.apply(addJiraUser(this.teamId(), user), 'Integrante agregado.');
      if (result.ok) this.closed.emit();
    } finally {
      this.saving.set(false);
    }
  }
}
