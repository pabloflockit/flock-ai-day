import { Pipe, PipeTransform } from '@angular/core';
import { formatInstant } from '../../../../shared/domain/format.mjs';

/**
 * Formats an INSTANT (ISO with `Z`) in the user's local zone (or `timeZone` when given).
 * Never pass a calendar date (`YYYY-MM-DD`) here: use the `calendarDate` pipe, otherwise the
 * day shifts back in UTC-3.
 */
@Pipe({ name: 'instant' })
export class InstantPipe implements PipeTransform {
  transform(value: string | null | undefined, locale = 'es-AR', timeZone?: string): string {
    return value ? formatInstant(value, locale, timeZone) : '';
  }
}
