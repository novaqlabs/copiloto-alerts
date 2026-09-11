import { describe, expect, it } from 'vitest';
import { buildOutputs } from '../outputs.ts';
import { loadCatalogo } from '../catalogo.ts';

const NOW = new Date('2026-09-08T20:00:00Z');
const radar = { id: 'r1', lat: 40.4, lng: -3.7, kind: 'fixed' as const, source: 'dgt' as const, direction: 'positive' as const, road: 'M-30' };
const inc = { id: 'i1', type: 'roadworks' as const, lat: 41.6, lng: -0.9, text: 'Obras en Z-40', validFrom: '2026-09-08T10:00:00+02:00', source: 'dgt' as const, road: 'Z-40' };

describe('buildOutputs', () => {
  const out = buildOutputs({ radares: [radar], incidencias: [inc], catalogo: loadCatalogo(), now: NOW,
    sources: { radares: { fetchedAt: NOW.toISOString(), records: 1, ok: true }, incidencias: { fetchedAt: NOW.toISOString(), records: 1, ok: true } } });
  it('reparte por celdas de un grado', () => {
    expect(out.get('radares/40_-4.json')).toEqual([radar]);
    expect(out.get('incidencias/41_-1.json')).toEqual([inc]);
    expect(out.has('incidencias/40_-4.json')).toBe(false);
  });
  it('meta lista las celdas con contenido y las fuentes', () => {
    const meta = out.get('meta.json') as any;
    expect(meta.contractVersion).toBe(1);
    expect(meta.generatedAt).toBe(NOW.toISOString());
    expect(meta.cells).toEqual({ radares: ['40_-4'], incidencias: ['41_-1'], trafico: [], historico: [], usuarios: [] });
    expect(meta.sources.radares.records).toBe(1);
  });
  it('incluye el catalogo tal cual', () => {
    expect((out.get('catalogo.json') as any).types.length).toBe(10);
  });
  it('descarta lo que cae fuera de la cobertura', () => {
    const out2 = buildOutputs({ radares: [{ ...radar, id: 'r2', lat: 48.8, lng: 2.3 }], incidencias: [], catalogo: loadCatalogo(), now: NOW,
      sources: { radares: { fetchedAt: NOW.toISOString(), records: 1, ok: true }, incidencias: { fetchedAt: NOW.toISOString(), records: 0, ok: true } } });
    expect([...out2.keys()].filter((k) => k.startsWith('radares/'))).toEqual([]);
    expect((out2.get('meta.json') as any).discarded.outOfCoverage).toBe(1);
  });
  it('publica en meta.json los descartes de incidencias por tipo (M8)', () => {
    const out2 = buildOutputs({ radares: [], incidencias: [], catalogo: loadCatalogo(), now: NOW,
      sources: { radares: { fetchedAt: NOW.toISOString(), records: 0, ok: true }, incidencias: { fetchedAt: NOW.toISOString(), records: 0, ok: true } },
      discardedIncidencias: { UnknownXsiType: 3, sin_coordenadas: 1 } });
    expect((out2.get('meta.json') as any).discarded).toEqual({ outOfCoverage: 0, byType: { UnknownXsiType: 3, sin_coordenadas: 1 } });
  });
  it('discarded.byType es un objeto vacio cuando no se pasan descartes de incidencias', () => {
    expect((out.get('meta.json') as any).discarded.byType).toEqual({});
  });
  it('reparte los sitios de trafico por celda y los lista en meta.cells.trafico', () => {
    const sitio = {
      id: 'GUID_DET_138003', lat: 40.462196, lng: -3.77084, road: 'A-6', bearing: 300,
      speedKmh: 102, level: 'free' as const, ratio: 0.93, measuredAt: '2026-09-10T22:25:00+02:00',
    };
    const out3 = buildOutputs({
      radares: [], incidencias: [], catalogo: loadCatalogo(), now: NOW,
      sources: {
        radares: { fetchedAt: NOW.toISOString(), records: 0, ok: true },
        incidencias: { fetchedAt: NOW.toISOString(), records: 0, ok: true },
        trafico: { fetchedAt: NOW.toISOString(), records: 1, withSpeed: 1, ok: true },
      },
      trafico: [sitio],
    });
    expect(out3.get('trafico/40_-4.json')).toEqual([sitio]);
    const meta3 = out3.get('meta.json') as any;
    expect(meta3.cells.trafico).toEqual(['40_-4']);
    expect(meta3.sources.trafico).toEqual({ fetchedAt: NOW.toISOString(), records: 1, withSpeed: 1, ok: true });
    expect(meta3.contractVersion).toBe(1);
  });
});
