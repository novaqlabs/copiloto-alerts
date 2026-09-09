/**
 * Ventana diaria de mantenimiento (04:00-04:09 UTC) para las tareas de `cli.ts` que solo deben
 * correr una vez al dia (sincronizar `report_types`, limpiar trazas antiguas) aunque el CLI se
 * ejecute cada 10 minutos.
 */
export function isDailyMaintenanceWindow(now: Date): boolean {
  return now.getUTCHours() === 4 && now.getUTCMinutes() < 10;
}
