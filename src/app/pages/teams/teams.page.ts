import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { addTeam, removeTeam, updateTeam } from '../../../../shared/config-edit.mjs';
import { teamSummaries } from '../../../../shared/config-view.mjs';
import { ConfigEditor } from '../../core/config-editor';
import { AppStore } from '../../core/store/app-store';
import { ConfirmService } from '../../shared/ui/confirm.service';
import { Icon } from '../../shared/ui/icon';
import { Modal } from '../../shared/ui/modal';

/** `id: null` creates; otherwise edits that team. */
interface TeamForm {
  id: string | null;
}

/** Teams list (plan §6.1.2): counts per team, create/edit modal, activate, delete. */
@Component({
  selector: 'app-teams-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Icon, Modal],
  templateUrl: './teams.page.html',
  styleUrl: './teams.page.scss',
})
export class TeamsPage {
  readonly #store = inject(AppStore);
  readonly #editor = inject(ConfigEditor);
  readonly #confirm = inject(ConfirmService);

  readonly configState = this.#store.configState;
  readonly summaries = computed(() => {
    const config = this.#store.config();
    return config ? teamSummaries(config) : [];
  });

  readonly form = signal<TeamForm | null>(null);
  readonly name = signal('');
  readonly description = signal('');
  readonly nameError = signal<string | null>(null);
  readonly formError = signal<string | null>(null);
  readonly saving = signal(false);

  constructor() {
    void this.#store.loadConfig();
  }

  openCreate(): void {
    this.#open({ id: null }, '', '');
  }

  openEdit(id: string, name: string, description: string | null): void {
    this.#open({ id }, name, description ?? '');
  }

  closeForm(): void {
    this.form.set(null);
  }

  async submit(): Promise<void> {
    const form = this.form();
    if (!form || this.saving()) return;
    const name = this.name();
    const description = this.description();
    this.saving.set(true);
    this.nameError.set(null);
    this.formError.set(null);
    try {
      const result = form.id
        ? await this.#editor.apply((c) => updateTeam(c, form.id!, { name, description }), 'Equipo actualizado.')
        : await this.#editor.apply((c) => addTeam(c, { id: crypto.randomUUID(), name, description }), 'Equipo creado.');
      if (result.ok) {
        this.form.set(null);
        return;
      }
      this.nameError.set(result.issues.find((i) => i.path === 'name')?.message ?? null);
      this.formError.set(result.issues.find((i) => i.path !== 'name')?.message ?? null);
    } finally {
      this.saving.set(false);
    }
  }

  async toggleActive(id: string, active: boolean): Promise<void> {
    await this.#editor.apply((c) => updateTeam(c, id, { active }), active ? 'Equipo activado.' : 'Equipo desactivado.');
  }

  async remove(id: string, name: string): Promise<void> {
    const accepted = await this.#confirm.ask({
      title: 'Eliminar equipo',
      message: `¿Eliminar el equipo "${name}"? Se quitan también sus integrantes.`,
      confirmLabel: 'Eliminar',
    });
    if (accepted) await this.#editor.apply((c) => removeTeam(c, id), 'Equipo eliminado.');
  }

  #open(form: TeamForm, name: string, description: string): void {
    this.name.set(name);
    this.description.set(description);
    this.nameError.set(null);
    this.formError.set(null);
    this.form.set(form);
  }
}
