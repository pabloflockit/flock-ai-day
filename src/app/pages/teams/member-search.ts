import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { initials, userSearchHits } from '../../../../shared/config-view.mjs';
import { idle, track, type Op } from '../../core/op';
import { ProxyClient } from '../../core/proxy-client';
import { AppStore } from '../../core/store/app-store';

export const MEMBER_SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

/** A Jira user as `GET /api/jira/users` returns it. */
export interface JiraUserHit {
  accountId: string;
  displayName: string;
  emailAddress: string | null;
  /** Present in Jira responses; the typed hit view omits it. */
  active?: boolean;
}

/**
 * Jira people search for adding team members (plan §6.1.3). Debounced; only the latest query's
 * response is applied. Adding is the parent's job: this component only emits the chosen user.
 */
@Component({
  selector: 'app-member-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './member-search.html',
  styleUrl: './member-search.scss',
})
export class MemberSearch {
  readonly #store = inject(AppStore);
  readonly #proxy = inject(ProxyClient);

  readonly teamId = input.required<string>();
  readonly add = output<JiraUserHit>();

  readonly initials = initials;
  readonly jiraReady = this.#store.jiraReady;
  readonly search = signal<Op<JiraUserHit[]>>(idle());
  readonly hits = computed(() => {
    const config = this.#store.config();
    const users = this.search().data;
    return config && users ? userSearchHits(config, this.teamId(), users) : [];
  });

  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Incremented per query; a response only lands when it still belongs to the latest one. */
  #latest = 0;

  constructor() {
    // A pending search must not fire after the page is left.
    inject(DestroyRef).onDestroy(() => clearTimeout(this.#timer));
  }

  onInput(value: string): void {
    clearTimeout(this.#timer);
    const text = value.trim();
    const id = ++this.#latest;
    if (text.length < MIN_QUERY_LENGTH) {
      this.search.set(idle());
      return;
    }
    this.#timer = setTimeout(() => void this.#run(text, id), MEMBER_SEARCH_DEBOUNCE_MS);
  }

  async #run(text: string, id: number): Promise<void> {
    const result = signal<Op<JiraUserHit[]>>(idle());
    this.search.set({ status: 'loading', data: null, error: null });
    await track(result, () =>
      this.#proxy.get<JiraUserHit[]>(`/api/jira/users?query=${encodeURIComponent(text)}`),
    );
    if (id === this.#latest) this.search.set(result());
  }
}
