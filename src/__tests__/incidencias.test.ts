import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapType, parseIncidencias } from '../incidencias.ts';

const xml = readFileSync(new URL('../../fixtures/incidencias.xml', import.meta.url), 'utf8');
const NOW = new Date('2026-09-08T20:00:00+02:00');

describe('mapType', () => {
  it('cierres y carriles', () => {
    expect(mapType('RoadOrCarriagewayOrLaneManagement', 'roadOrCarriagewayOrLaneManagement', { roadOrCarriagewayOrLaneManagementType: 'roadClosed' })).toEqual({ type: 'closure', subtype: 'road' });
    expect(mapType('RoadOrCarriagewayOrLaneManagement', 'roadMaintenance', { roadOrCarriagewayOrLaneManagementType: 'laneClosures' })).toEqual({ type: 'closure', subtype: 'lane' });
    expect(mapType('RoadOrCarriagewayOrLaneManagement', undefined, { roadOrCarriagewayOrLaneManagementType: 'carriagewayClosures' })).toEqual({ type: 'closure', subtype: 'road' });
  });
  it('genericos por causa', () => {
    expect(mapType('GenericSituationRecord', 'roadMaintenance', {})).toEqual({ type: 'roadworks' });
    expect(mapType('GenericSituationRecord', 'accident', {})).toEqual({ type: 'accident' });
    expect(mapType('GenericSituationRecord', 'vehicleObstruction', {})).toEqual({ type: 'hazard', subtype: 'road' });
    expect(mapType('GenericSituationRecord', 'environmentalObstruction', {})).toEqual({ type: 'hazard', subtype: 'object' });
    expect(mapType('GenericSituationRecord', 'abnormalTraffic', {})).toEqual({ type: 'jam' });
    expect(mapType('GenericSituationRecord', 'poorEnvironment', {})).toEqual({ type: 'weather' });
  });
  it('tipos propios y descartes', () => {
    expect(mapType('Accident', 'accident', {})).toEqual({ type: 'accident' });
    expect(mapType('AbnormalTraffic', 'abnormalTraffic', { abnormalTrafficType: 'slowTraffic' })).toEqual({ type: 'jam' });
    expect(mapType('PoorEnvironmentConditions', 'poorEnvironment', { poorEnvironmentType: 'fog' })).toEqual({ type: 'weather', subtype: 'fog' });
    expect(mapType('NonWeatherRelatedRoadConditions', undefined, {})).toEqual({ type: 'hazard', subtype: 'road' });
    expect(mapType('GeneralObstruction', 'obstruction', { obstructionType: 'objectOnTheRoad' })).toEqual({ type: 'hazard', subtype: 'object' });
    expect(mapType('SpeedManagement', undefined, {})).toBeUndefined();
    expect(mapType('GeneralInstructionOrMessageToRoadUsers', undefined, {})).toBeUndefined();
    expect(mapType('GenericSituationRecord', 'publicEvent', {})).toBeUndefined();
  });
});

describe('parseIncidencias', () => {
  const { items, discarded } = parseIncidencias(xml, NOW);
  it('convierte la mayoria de los 887 registros y cuenta los descartados por tipo', () => {
    expect(items.length).toBeGreaterThanOrEqual(850);
    expect(items.length + Object.values(discarded).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(880);
    expect(discarded['SpeedManagement']).toBeGreaterThanOrEqual(1);
  });
  it('el registro 18811074 es obras en la N-400 con inicio y fin', () => {
    const r = items.find((i) => i.id === '18811074')!;
    expect(r.type).toBe('roadworks');
    expect(r.road).toBe('N-400');
    expect(r.validFrom).toBe('2025-12-12T08:05:19.000+01:00');
    expect(r.validTo).toBeUndefined();
    expect(Number.isFinite(r.lat) && Number.isFinite(r.lng)).toBe(true);
    expect(r.endLat === undefined || Number.isFinite(r.endLat)).toBe(true);
  });
  it('todas tienen texto, coordenadas y tipo del catalogo', () => {
    const allowed = new Set(['accident', 'hazard', 'closure', 'jam', 'roadworks', 'weather']);
    for (const i of items) {
      expect(allowed.has(i.type)).toBe(true);
      expect(i.text.length).toBeGreaterThan(3);
      expect(i.lat).toBeGreaterThan(27); expect(i.lat).toBeLessThan(45);
      expect(i.source).toBe('dgt');
    }
  });
  it('descarta las que ya han terminado', () => {
    const later = new Date('2030-01-01T00:00:00Z');
    const { items: future } = parseIncidencias(xml, later);
    expect(future.length).toBeLessThan(items.length);
  });
});
