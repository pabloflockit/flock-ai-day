/** Plan §5.3: app status category -> Flock state color (status chip / bar class suffix). */
export const CATEGORY_STATE = {
  todo: 'state-pending',
  doing: 'state-progress',
  done: 'state-done',
} as const;

/** Extra mark for stale units (plan §5.3: "Estancada" -> Bloqueado). */
export const STALE_STATE = 'state-blocked';
