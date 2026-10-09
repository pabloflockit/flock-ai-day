/**
 * Deterministic canned narrative for `--demo` (works offline, no provider call). Built from the
 * `narrativeInput` figures only, and labelled as demo. Returns the raw model text (JSON).
 *
 * @param {any} input
 * @returns {string}
 */
export function demoNarrative(input) {
  const k = input?.kpis ?? {};
  const n = (/** @type {unknown} */ v) => (Number.isFinite(v) ? Number(v) : 0);
  return JSON.stringify({
    titulares: [
      `[Demo] ${n(k.withMovement)} ítems con movimiento en el período`,
      `[Demo] ${n(k.closed)} cerrados y ${n(k.blocked)} bloqueados`,
    ],
    lectura:
      `[Texto de demostración, no generado por un modelo] En el período hubo ${n(k.withMovement)} ítems con movimiento: ` +
      `${n(k.primaries)} primarias y ${n(k.secondaries)} secundarias. Se cerraron ${n(k.closed)} y ${n(k.blocked)} siguen bloqueados.`,
  });
}
