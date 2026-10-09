import { Pipe, PipeTransform } from '@angular/core';
import { formatCalendarDate } from '../../../../shared/domain/format.mjs';

/**
 * Formats a CALENDAR DATE (`YYYY-MM-DD`, e.g. `dueDate`) without any zone conversion.
 * For instants (ISO with `Z`) use the `instant` pipe. Mixing them shifts the day in UTC-3.
 */
@Pipe({ name: 'calendarDate' })
export class CalendarDatePipe implements PipeTransform {
  transform(value: string | null | undefined, locale = 'es-AR'): string {
    return value ? formatCalendarDate(value, locale) : '';
  }
}
