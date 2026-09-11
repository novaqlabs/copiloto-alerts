import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bearingForDetectors,
  buildTrafficSites,
  defaultReferenceKmh,
  parseDetectorLocations,
  parseDetectorMeasurements,
  publicationTimeOf,
} from '../detectores.ts';

const ubicacionesXml = readFileSync(new URL('../../fixtures/detectores-ubicaciones.xml', import.meta.url), 'utf8');
const medidasXml = readFileSync(new URL('../../fixtures/detectores-medidas.xml', import.meta.url), 'utf8');

const locations = parseDetectorLocations(ubicacionesXml);
const measurements = parseDetectorMeasurements(medidasXml);
const bearings = bearingForDetectors(locations);
// El "ahora" se INYECTA: es el publicationTime real del fixture, nunca Date.now().
const publishedAt = new Date('2026-09-10T22:26:23.908+02:00');
const sites = buildTrafficSites({ locations, measurements, publishedAt, bearings });
const byId = new Map(sites.map((s) => [s.id, s] as const));
const bearingOf = (id: string) => byId.get(id)?.bearing ?? null;

describe('parseDetectorLocations', () => {
  it('lee los 22 detectores del extracto con carretera, area, sentido, PK y singularidad', () => {
    expect(locations.length).toBe(22);
    expect(locations[0]).toEqual({
      id: 'GUID_DET_137934',
      lat: 40.43546,
      lng: -3.719572,
      road: 'A-6',
      area: 'MADRID',
      direction: 'positive',
      pkM: 3500,
      singularity: 'AUTOPISTA / AUTOVÍA',
    });
    const salida = locations.find((l) => l.id === 'GUID_DET_140834');
    expect(salida?.singularity).toBe('SALIDA');
    expect(salida?.direction).toBe('negative');
    expect(salida?.pkM).toBe(972600);
    const busVao = locations.find((l) => l.id === 'GUID_DET_138083');
    expect(busVao?.singularity).toBe('BUS-VAO');
    expect(busVao?.direction).toBe('unknown');
  });
});

describe('parseDetectorMeasurements', () => {
  it('lee velocidad, flujo, ocupacion y hora de cada bloque siteMeasurements', () => {
    expect(measurements.length).toBe(22);
    expect(measurements.find((m) => m.id === 'GUID_DET_138003')).toEqual({
      id: 'GUID_DET_138003',
      measuredAt: '2026-09-10T22:25:00+02:00',
      speedKmh: 102,
      flowVehH: 1020,
      occupancyPct: 2,
    });
    // Un detector sin bloque TrafficSpeed no trae velocidad (no trae un 0 inventado).
    expect(measurements.find((m) => m.id === 'GUID_DET_140834')).toEqual({
      id: 'GUID_DET_140834',
      measuredAt: '2026-09-10T22:25:00+02:00',
      flowVehH: 300,
      occupancyPct: 6,
    });
    // TrafficHeadway (averageDistanceHeadway) se ignora: no es ni velocidad ni flujo ni ocupacion.
    expect(measurements.find((m) => m.id === 'GUID_DET_137934')).toEqual({
      id: 'GUID_DET_137934',
      measuredAt: '2026-09-10T22:25:00+02:00',
      speedKmh: 0,
      flowVehH: 0,
      occupancyPct: 0,
    });
  });

  it('publicationTimeOf devuelve la hora de publicacion del feed', () => {
    expect(publicationTimeOf(medidasXml)).toBe('2026-09-10T22:26:23.908+02:00');
  });
});

describe('buildTrafficSites — descartes', () => {
  it('publica solo los once detectores con medida util', () => {
    expect(sites.map((s) => s.id)).toEqual([
      'GUID_DET_130397',
      'GUID_DET_137913',
      'GUID_DET_138002',
      'GUID_DET_138003',
      'GUID_DET_138016',
      'GUID_DET_138017',
      'GUID_DET_138018',
      'GUID_DET_138019',
      'GUID_DET_139376',
      'GUID_DET_139710',
      'GUID_DET_141438',
    ]);
  });

  it('los tres del PK 3.500 de la A-6 se van por velocidad 0 con flujo 0', () => {
    expect(byId.has('GUID_DET_137931')).toBe(false);
    expect(byId.has('GUID_DET_137933')).toBe(false);
    expect(byId.has('GUID_DET_137934')).toBe(false);
    expect(byId.has('GUID_DET_168863')).toBe(false);
  });

  it('los dos parados desde 2025-06-30 se van por antiguedad', () => {
    expect(byId.has('GUID_DET_133396')).toBe(false);
    expect(byId.has('GUID_DET_133398')).toBe(false);
  });

  it('BUS-VAO, SALIDA y ENTRADA no miden la calzada principal', () => {
    expect(byId.has('GUID_DET_138082')).toBe(false);
    expect(byId.has('GUID_DET_138083')).toBe(false);
    expect(byId.has('GUID_DET_140834')).toBe(false);
    expect(byId.has('GUID_DET_140975')).toBe(false);
  });

  it('sin velocidad y con ocupacion por debajo de 40 no se publica', () => {
    expect(byId.has('GUID_DET_130243')).toBe(false);
  });

  it('sin velocidad pero con ocupacion alta se publica como atasco sin velocidad', () => {
    const soloOcupacion = buildTrafficSites({
      locations: [{ id: 'X', lat: 40.5, lng: -3.5, road: 'A-1', direction: 'positive', pkM: 1000, singularity: 'AUTOPISTA / AUTOVÍA' }],
      measurements: [{ id: 'X', measuredAt: '2026-09-10T22:25:00+02:00', flowVehH: 600, occupancyPct: 55 }],
      publishedAt,
    });
    expect(soloOcupacion).toEqual([{
      id: 'X', lat: 40.5, lng: -3.5, road: 'A-1', bearing: null,
      speedKmh: null, level: 'jam', ratio: null, measuredAt: '2026-09-10T22:25:00+02:00',
    }]);
  });
});

describe('buildTrafficSites — niveles y referencia por defecto', () => {
  it('la referencia por defecto sale de la singularidad y, si no, del prefijo de la via', () => {
    expect(defaultReferenceKmh({ id: 'a', lat: 0, lng: 0, direction: 'unknown', singularity: 'AUTOPISTA / AUTOVÍA' })).toBe(110);
    expect(defaultReferenceKmh({ id: 'a', lat: 0, lng: 0, direction: 'unknown', singularity: 'CIRCUNVALACIÓN' })).toBe(90);
    expect(defaultReferenceKmh({ id: 'a', lat: 0, lng: 0, direction: 'unknown', singularity: 'CARRETERA NACIONAL' })).toBe(85);
    expect(defaultReferenceKmh({ id: 'a', lat: 0, lng: 0, direction: 'unknown', singularity: 'NINGUNA', road: 'AP-7' })).toBe(110);
    expect(defaultReferenceKmh({ id: 'a', lat: 0, lng: 0, direction: 'unknown', singularity: 'NINGUNA', road: 'N-340' })).toBe(85);
    expect(defaultReferenceKmh({ id: 'a', lat: 0, lng: 0, direction: 'unknown', singularity: 'CARRETERA AUTONÓMICA', road: 'CV-410' })).toBe(60);
  });

  it('102 km/h en una autovia es fluido y 39 km/h es atasco', () => {
    expect(byId.get('GUID_DET_138003')).toEqual({
      id: 'GUID_DET_138003',
      lat: 40.462196,
      lng: -3.77084,
      road: 'A-6',
      bearing: bearingOf('GUID_DET_138003'),
      speedKmh: 102,
      level: 'free',
      ratio: 0.93,
      measuredAt: '2026-09-10T22:25:00+02:00',
    });
    expect(byId.get('GUID_DET_139710')?.level).toBe('jam');
    expect(byId.get('GUID_DET_139710')?.ratio).toBe(0.35);
  });

  it('los dos lentos del extracto quedan en slow', () => {
    expect(byId.get('GUID_DET_138016')?.level).toBe('slow');   // 59 / 110 = 0,54
    expect(byId.get('GUID_DET_137913')?.level).toBe('slow');   // 57 / 85  = 0,67
    expect(byId.get('GUID_DET_139376')?.level).toBe('free');   // 85 / 85  = 1,00
    expect(byId.get('GUID_DET_141438')?.level).toBe('free');   // 80 / 60  = 1,33
  });
});

describe('buildTrafficSites — fusion por punto y sentido', () => {
  it('dos carriles del mismo punto y sentido se fusionan con la media ponderada por flujo', () => {
    const carriles = [
      { id: 'A', lat: 40.5, lng: -3.5, road: 'A-1', direction: 'positive' as const, pkM: 1000, singularity: 'AUTOPISTA / AUTOVÍA' },
      { id: 'B', lat: 40.5, lng: -3.5, road: 'A-1', direction: 'positive' as const, pkM: 1000, singularity: 'AUTOPISTA / AUTOVÍA' },
      { id: 'C', lat: 40.5, lng: -3.5, road: 'A-1', direction: 'negative' as const, pkM: 1000, singularity: 'AUTOPISTA / AUTOVÍA' },
    ];
    const medidas = [
      { id: 'A', measuredAt: '2026-09-10T22:25:00+02:00', speedKmh: 100, flowVehH: 300 },
      { id: 'B', measuredAt: '2026-09-10T22:25:00+02:00', speedKmh: 20, flowVehH: 900 },
      { id: 'C', measuredAt: '2026-09-10T22:25:00+02:00', speedKmh: 88, flowVehH: 120 },
    ];
    const fusionados = buildTrafficSites({ locations: carriles, measurements: medidas, publishedAt });
    // El sentido contrario NO se fusiona con los dos carriles del mismo sentido.
    expect(fusionados.map((s) => s.id)).toEqual(['A', 'C']);
    // (100 x 300 + 20 x 900) / 1200 = 40 km/h -> 40/110 = 0,36 -> jam
    expect(fusionados[0].speedKmh).toBe(40);
    expect(fusionados[0].ratio).toBe(0.36);
    expect(fusionados[0].level).toBe('jam');
    expect(fusionados[1].speedKmh).toBe(88);
    expect(fusionados[1].level).toBe('free');
  });

  it('sin flujo en ninguno de los carriles se usa la media simple', () => {
    const carriles = [
      { id: 'A', lat: 40.5, lng: -3.5, road: 'A-1', direction: 'positive' as const, pkM: 1000, singularity: 'AUTOPISTA / AUTOVÍA' },
      { id: 'B', lat: 40.5, lng: -3.5, road: 'A-1', direction: 'positive' as const, pkM: 1000, singularity: 'AUTOPISTA / AUTOVÍA' },
    ];
    const medidas = [
      { id: 'A', measuredAt: '2026-09-10T22:25:00+02:00', speedKmh: 100 },
      { id: 'B', measuredAt: '2026-09-10T22:25:00+02:00', speedKmh: 60 },
    ];
    expect(buildTrafficSites({ locations: carriles, measurements: medidas, publishedAt })[0].speedKmh).toBe(80);
  });
});

describe('bearingForDetectors', () => {
  it('los positive de la A-6 miran al noroeste y los negative al sureste', () => {
    expect(bearingOf('GUID_DET_138003')).toBeGreaterThanOrEqual(290);
    expect(bearingOf('GUID_DET_138003')).toBeLessThanOrEqual(315);
    expect(bearingOf('GUID_DET_138002')).toBe(bearingOf('GUID_DET_138003'));
    expect(bearingOf('GUID_DET_138017')).toBeGreaterThanOrEqual(95);
    expect(bearingOf('GUID_DET_138017')).toBeLessThanOrEqual(135);
    expect(bearingOf('GUID_DET_139710')).toBeGreaterThanOrEqual(110);
    expect(bearingOf('GUID_DET_139710')).toBeLessThanOrEqual(140);
  });

  it('sin vecino de PK fiable el rumbo es null', () => {
    // El unico detector de la A-7 en Valencia: sus vecinos de PK estan en Malaga, a mas de 30 km.
    expect(bearingOf('GUID_DET_130397')).toBeNull();
    // Una via con un unico detector (N-550) no da rumbo.
    expect(bearingOf('GUID_DET_137913')).toBeNull();
    // directionRelative unknown (los BUS-VAO) nunca lleva rumbo, aunque su via tenga PKs.
    expect(bearings.get('GUID_DET_138083')).toBeNull();
  });

  it('positive y negative del mismo PK son opuestos', () => {
    const positivo = bearings.get('GUID_DET_138003');
    const negativo = bearings.get('GUID_DET_138016');
    expect(positivo).not.toBeNull();
    expect(negativo).not.toBeNull();
    // No comparten vecinos (PK distinto), pero los dos rumbos apuntan a mitades opuestas de la
    // rosa: la diferencia angular minima (0 = mismo rumbo, 180 = exactamente opuesto) pasa de 135.
    const diff = Math.abs(((((positivo ?? 0) - (negativo ?? 0)) % 360) + 540) % 360 - 180);
    expect(diff).toBeGreaterThan(135);
  });
});
