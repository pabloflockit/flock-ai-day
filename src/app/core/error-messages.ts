/** Spanish texts for error codes that reach the UI without a message (e.g. a failed shard). */
const MESSAGES: Record<string, string> = {
  TRANSPORT_ERROR: 'No se pudo conectar con el servicio local.',
  UNAUTHORIZED: 'El servicio local rechazó la solicitud.',
  VALIDATION_ERROR: 'Los datos enviados no son válidos.',
  NOT_FOUND: 'No se encontró el recurso pedido.',
  JIRA_NOT_CONFIGURED: 'Todavía no hay una URL de Jira configurada.',
  NOT_CLOUD: 'Solo se admite Jira Cloud.',
  URL_NOT_VERIFIED: 'La URL de Jira todavía no fue verificada como Jira Cloud.',
  NOT_AN_EPIC: 'La issue indicada no es una épica.',
  AUTH: 'Jira rechazó las credenciales (email o token).',
  FORBIDDEN: 'Tu usuario no tiene permiso para ver este recurso en Jira.',
  UNREACHABLE: 'No se pudo llegar a Jira.',
  TLS: 'Falló la conexión segura con Jira.',
  TIMEOUT: 'Jira tardó demasiado en responder.',
  RATE_LIMIT: 'Jira pidió reducir el ritmo de consultas. Reintentá en unos minutos.',
  BAD_QUERY: 'Jira rechazó la consulta.',
  SERVER_ERROR: 'Jira respondió con un error interno.',
  DATA_KEY_INVALID: 'No se pudo descifrar la base local.',
  STORAGE_UNAVAILABLE: 'El almacenamiento local no está disponible.',
  EGRESS_BLOCKED: 'La conexión a ese destino está bloqueada.',
  UNKNOWN: 'Ocurrió un error inesperado.',
};

export function errorMessageEs(code: string): string {
  return MESSAGES[code] ?? MESSAGES['UNKNOWN'];
}
