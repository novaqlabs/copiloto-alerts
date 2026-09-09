import { describe, expect, it } from 'vitest';
import { isDailyMaintenanceWindow } from '../schedule.ts';

describe('isDailyMaintenanceWindow', () => {
  it('es verdadero dentro de la ventana 04:00-04:09 UTC', () => {
    expect(isDailyMaintenanceWindow(new Date('2026-09-08T04:00:00Z'))).toBe(true);
    expect(isDailyMaintenanceWindow(new Date('2026-09-08T04:05:30Z'))).toBe(true);
    expect(isDailyMaintenanceWindow(new Date('2026-09-08T04:09:59Z'))).toBe(true);
  });

  it('es falso fuera de la ventana', () => {
    expect(isDailyMaintenanceWindow(new Date('2026-09-08T03:59:59Z'))).toBe(false);
    expect(isDailyMaintenanceWindow(new Date('2026-09-08T04:10:00Z'))).toBe(false);
    expect(isDailyMaintenanceWindow(new Date('2026-09-08T14:05:00Z'))).toBe(false);
  });
});
