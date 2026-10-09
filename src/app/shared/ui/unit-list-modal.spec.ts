import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { WorkUnit } from '../../../../shared/domain/work-units.mjs';
import { UnitListModal } from './unit-list-modal';

const unit = (key: string, extra: Partial<WorkUnit> = {}) =>
  ({
    key,
    summary: `Resumen ${key}`,
    statusName: 'En curso',
    statusCategory: 'doing',
    assigneeName: 'Ana',
    measureValue: 2.5,
    ...extra,
  }) as WorkUnit;

function render(inputs: { units: WorkUnit[]; measure?: unknown }) {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(UnitListModal);
  fixture.componentRef.setInput('title', 'En curso');
  fixture.componentRef.setInput('units', inputs.units);
  if (inputs.measure) fixture.componentRef.setInput('measure', inputs.measure);
  fixture.detectChanges();
  return fixture;
}

describe('UnitListModal', () => {
  afterEach(() => delete (window as { leadershipPanel?: unknown }).leadershipPanel);

  it('lists the units with status color, assignee and formatted measure', () => {
    const fixture = render({
      units: [unit('A-1'), unit('A-2', { statusCategory: 'done', assigneeName: null, measureValue: null })],
      measure: { kind: 'field', fieldId: 'cf', fieldName: 'Estimación', valueType: 'time_seconds' },
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h2')?.textContent).toContain('En curso (2)');
    const rows = el.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('A-1');
    expect(rows[0].textContent).toContain('2,5 h');
    expect(rows[0].querySelector('.status-chip')?.classList).toContain('state-progress');
    expect(rows[1].querySelector('.status-chip')?.classList).toContain('state-done');
    expect(rows[1].textContent).toContain('Sin asignar');
    expect(rows[1].textContent).toContain('Sin dato');
  });

  it('shows an empty message without units', () => {
    const el = render({ units: [] }).nativeElement as HTMLElement;
    expect(el.textContent).toContain('No hay unidades para mostrar');
  });

  it('hides the measure column for the quantity measure', () => {
    const el = render({ units: [unit('A-1')] }).nativeElement as HTMLElement;
    expect(el.querySelectorAll('th').length).toBe(4);
  });

  it('opens the issue in Jira through the bridge and reports a failure', async () => {
    const openInJira = jasmine.createSpy('openInJira').and.resolveTo({ ok: false });
    (window as { leadershipPanel?: unknown }).leadershipPanel = { openInJira };
    const fixture = render({ units: [unit('A-1')] });
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('tbody .num-link')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(openInJira).toHaveBeenCalledWith('A-1');
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('No se pudo abrir');
  });

  it('shows the key as plain text outside the Electron bridge and emits closed', () => {
    const fixture = render({ units: [unit('A-1')] });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('tbody .num-link')).toBeNull();
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    el.querySelector<HTMLButtonElement>('.modal-foot button')!.click();
    expect(closed).toBe(1);
  });
});
