import { describe, expect, it } from 'vitest';
import {
  ESTADO_VERSION,
  emptyEstado,
  historicoSites,
  hourlySlot,
  locationsAreStale,
  locationsFromEstado,
  madridDay,
  parseEstado,
  referenceFor,
  TRACE_MAX_AGE_DAYS,
  pruneTraces,
  updateEstado,
  type Estado,
} from '../estado.ts';
import type { TrafficSite } from '../detectores.ts';

const NOW = new Date('2026-09-10T22:26:23.908+02:00');   // jueves 22:26 en Madrid

function sitio(over: Partial<TrafficSite> = {}): TrafficSite {
  return {
    id: 'GUID_DET_138003',
    lat: 40.462196,
    lng: -3.77084,
    road: 'A-6',
    bearing: 300,
    speedKmh: 102,
    level: 'free',
    ratio: 0.93,
    measuredAt: '2026-09-10T22:25:00+02:00',
    ...over,
  };
}

describe('hourlySlot y madridDay', () => {
  it('la franja es (dia ISO - 1) x 24 + hora en hora de Madrid', () => {
    expect(hourlySlot(new Date('2026-09-07T00:30:00+02:00'))).toBe(0);      // lunes 00:xx
    expect(hourlySlot(new Date('2026-09-10T22:25:00+02:00'))).toBe(94);     // jueves 22:xx -> 3*24+22
    expect(hourlySlot(new Date('2026-09-13T23:59:00+02:00'))).toBe(167);    // domingo 23:xx -> 6*24+23
  });

  it('la franja usa la hora de Madrid, no UTC', () => {
    // 23:30 UTC del jueves son las 01:30 del VIERNES en Madrid (verano, +02:00).
    expect(hourlySlot(new Date('2026-09-10T23:30:00Z'))).toBe(4 * 24 + 1);
    expect(madridDay(new Date('2026-09-10T23:30:00Z'))).toBe('2026-09-11');
    expect(madridDay(NOW)).toBe('2026-09-10');
  });
});

describe('referenceFor', () => {
  it('es el percentil 85 del histograma de 5 km/h a partir de 20 muestras', () => {
    // 21 muestras: 80 (x5), 100 (x10), 110 (x6). 0,85 x 21 = 17,85 -> cae en el cubo 110.
    expect(referenceFor({ loc: loc(), hist: { '80': 5, '100': 10, '110': 6 }, slots: {} })).toBe(112.5);
  });

  it('con menos de 20 muestras no hay referencia', () => {
    expect(referenceFor({ loc: loc(), hist: { '100': 19 }, slots: {} })).toBeUndefined();
    expect(referenceFor(undefined)).toBeUndefined();
  });
});

function loc() {
  return { lat: 40.462196, lng: -3.77084, road: 'A-6', area: 'MADRID', bearing: 300, singularity: 'AUTOPISTA / AUTOVÍA', direction: 'positive' as const };
}

describe('updateEstado', () => {
  it('acumula la velocidad en el histograma y en la franja horaria', () => {
    const estado = updateEstado({ estado: emptyEstado(NOW), sites: [sitio()], now: NOW });
    const det = estado.detectors.GUID_DET_138003;
    expect(det.hist).toEqual({ '100': 1 });
    expect(det.slots).toEqual({ '94': [102, 1] });
    expect(estado.updatedAt).toBe(NOW.toISOString());
    expect(estado.decayedOn).toBe('2026-09-10');
  });

  it('la segunda muestra de la misma franja es una media movil exponencial con alfa 0,1', () => {
    const primera = updateEstado({ estado: emptyEstado(NOW), sites: [sitio()], now: NOW });
    const segunda = updateEstado({ estado: primera, sites: [sitio({ speedKmh: 90 })], now: NOW });
    const det = segunda.detectors.GUID_DET_138003;
    // 102 + 0,1 x (90 - 102) = 100,8
    expect(det.slots['94'][0]).toBeCloseTo(100.8, 6);
    expect(det.slots['94'][1]).toBe(2);
    expect(det.hist).toEqual({ '90': 1, '100': 1 });
  });

  it('un dia nuevo decae el histograma x0,95 antes de sumar la muestra', () => {
    const ayer: Estado = {
      ...emptyEstado(new Date('2026-09-09T22:00:00+02:00')),
      decayedOn: '2026-09-09',
      detectors: { GUID_DET_138003: { loc: loc(), hist: { '100': 10 }, slots: {} } },
    };
    const hoy = updateEstado({ estado: ayer, sites: [sitio()], now: NOW });
    // 10 x 0,95 = 9,5 y luego +1 por la muestra de hoy (mismo cubo 100).
    expect(hoy.detectors.GUID_DET_138003.hist['100']).toBeCloseTo(10.5, 6);
    expect(hoy.decayedOn).toBe('2026-09-10');
  });

  it('un sitio sin velocidad (atasco por ocupacion) no ensucia el histograma', () => {
    const estado = updateEstado({ estado: emptyEstado(NOW), sites: [sitio({ speedKmh: null, level: 'jam', ratio: null })], now: NOW });
    expect(estado.detectors.GUID_DET_138003).toBeUndefined();
  });

  it('guarda la ubicacion reducida y la fecha de descarga cuando se le pasan ubicaciones', () => {
    const estado = updateEstado({
      estado: emptyEstado(NOW),
      sites: [sitio()],
      now: NOW,
      locations: [{ id: 'GUID_DET_138003', lat: 40.462196, lng: -3.77084, road: 'A-6', area: 'MADRID', direction: 'positive', pkM: 9050, singularity: 'AUTOPISTA / AUTOVÍA' }],
      bearings: new Map([['GUID_DET_138003', 300]]),
    });
    expect(estado.detectors.GUID_DET_138003.loc).toEqual(loc());
    expect(estado.locationsAt).toBe(NOW.toISOString());
    expect(locationsFromEstado(estado)).toEqual([
      { id: 'GUID_DET_138003', lat: 40.462196, lng: -3.77084, road: 'A-6', area: 'MADRID', direction: 'positive', singularity: 'AUTOPISTA / AUTOVÍA' },
    ]);
  });
});

describe('poda de traces caducadas (TRACE_MAX_AGE_DAYS, I2)', () => {
  function estadoConTraces(decayedOn: string, seenDays: Record<string, string>): Estado {
    return {
      ...emptyEstado(NOW),
      decayedOn,
      traces: Object.fromEntries(Object.keys(seenDays).map((key) => [key, { '10': [50, 25] as [number, number] }])),
      traceSeenDays: seenDays,
    };
  }

  it('una celda vista hoy sobrevive al decaimiento diario', () => {
    const estado = estadoConTraces('2026-09-09', { viva: madridDay(NOW) });
    const resultado = pruneTraces(estado, NOW);
    expect(resultado.traces.viva).toBeDefined();
    expect(resultado.traceSeenDays.viva).toBe(madridDay(NOW));
  });

  it(`una celda sin visitas en mas de ${TRACE_MAX_AGE_DAYS} dias se poda`, () => {
    // 2026-08-01 esta a mas de 28 dias del NOW (10 de septiembre).
    const estado = estadoConTraces('2026-09-09', { muerta: '2026-08-01' });
    const resultado = pruneTraces(estado, NOW);
    expect(resultado.traces.muerta).toBeUndefined();
    expect(resultado.traceSeenDays.muerta).toBeUndefined();
  });

  it('podar es idempotente: repetirlo en la vuelta siguiente no reintroduce ni corrompe nada', () => {
    const estado = estadoConTraces('2026-09-09', { viva: '2026-09-08', muerta: '2026-08-01' });
    const dia1 = pruneTraces(estado, NOW);
    expect(Object.keys(dia1.traces)).toEqual(['viva']);

    const NOW2 = new Date(NOW.getTime() + 86_400_000); // la vuelta del dia siguiente
    const dia2 = pruneTraces(dia1, NOW2);
    expect(Object.keys(dia2.traces)).toEqual(['viva']);
    expect(dia2.traces.viva).toEqual(dia1.traces.viva);
    expect(dia2.traceSeenDays).toEqual(dia1.traceSeenDays);
  });

  it('una clave publicada antes de I2, sin traceSeenDays, se estrena con hoy en vez de borrarse de golpe', () => {
    const estado: Estado = { ...emptyEstado(NOW), decayedOn: '2026-09-09', traces: { antigua: { '10': [50, 25] } }, traceSeenDays: {} };
    const resultado = pruneTraces(estado, NOW);
    expect(resultado.traces.antigua).toBeDefined();
    expect(resultado.traceSeenDays.antigua).toBe(madridDay(NOW));
  });

  it('se poda aunque la DGT no responda: no depende de updateEstado', () => {
    // Re-revision de I2: la poda vivia dentro del bloque que solo corre con el feed de medidas, asi
    // que una caida de varios dias la dejaba callada mientras `updateTraces` seguia metiendo celdas.
    const estado = estadoConTraces('2026-09-09', { muerta: '2026-08-01', viva: madridDay(NOW) });
    // Ni una sola llamada a updateEstado en toda la vuelta (la DGT no ha respondido).
    const resultado = pruneTraces(estado, NOW);
    expect(Object.keys(resultado.traces)).toEqual(['viva']);
  });

  it('solo poda una vez al dia, aunque se llame varias veces', () => {
    const estado = estadoConTraces('2026-09-09', { antigua: '2026-08-01' });
    pruneTraces(estado, NOW);
    estado.traces.nueva = { '10': [60, 5] };
    estado.traceSeenDays.nueva = '2026-08-01';
    // Segunda llamada el mismo dia: no vuelve a recorrer nada, la celda recien metida sigue ahi.
    pruneTraces(estado, NOW);
    expect(estado.traces.nueva).toBeDefined();
  });
});

describe('locationsAreStale', () => {
  it('las ubicaciones se vuelven a descargar pasadas 24 h', () => {
    const reciente = { ...emptyEstado(NOW), locationsAt: '2026-09-10T02:00:00Z' };
    expect(locationsAreStale(reciente, NOW)).toBe(false);
    const viejo = { ...emptyEstado(NOW), locationsAt: '2026-09-09T02:00:00Z' };
    expect(locationsAreStale(viejo, NOW)).toBe(true);
    expect(locationsAreStale(emptyEstado(NOW), NOW)).toBe(true);
  });
});

describe('historicoSites', () => {
  it('solo publica los detectores con 20 muestras o mas en alguna franja', () => {
    const estado: Estado = {
      ...emptyEstado(NOW),
      detectors: {
        maduro: { loc: loc(), hist: {}, slots: { '94': [102.4, 20], '95': [80, 5] } },
        verde: { loc: loc(), hist: {}, slots: { '94': [70, 19] } },
      },
    };
    const historico = historicoSites(estado);
    expect(historico.length).toBe(1);
    expect(historico[0].id).toBe('maduro');
    expect(historico[0].profile.length).toBe(168);
    expect(historico[0].profile[94]).toBe(102.4);
    expect(historico[0].profile[95]).toBeNull();          // solo 5 muestras
    expect(historico[0].bearing).toBe(300);
    expect(historico[0].road).toBe('A-6');
  });
});

describe('parseEstado', () => {
  it('acepta el estado de la vuelta anterior', () => {
    const anterior = updateEstado({ estado: emptyEstado(NOW), sites: [sitio()], now: NOW });
    expect(parseEstado(JSON.stringify(anterior))).toEqual(anterior);
  });

  it('rechaza JSON invalido o de otra version sin lanzar', () => {
    expect(parseEstado('no soy json')).toBeUndefined();
    expect(parseEstado(JSON.stringify({ ...emptyEstado(NOW), version: ESTADO_VERSION + 1 }))).toBeUndefined();
  });
});
