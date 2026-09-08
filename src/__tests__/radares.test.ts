import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRadares } from '../radares.ts';

const xml = readFileSync(new URL('../../fixtures/radares.xml', import.meta.url), 'utf8');

describe('parseRadares', () => {
  const radares = parseRadares(xml);
  it('lee todos los radares de la muestra', () => {
    expect(radares.length).toBeGreaterThanOrEqual(700);
    expect(radares.length).toBeLessThanOrEqual(800);
    expect(new Set(radares.map((r) => r.id)).size).toBe(radares.length);
  });
  it('un tramo lleva inicio y fin y kind section', () => {
    const z40 = radares.find((r) => r.id === 'GUID_CVM_161274')!;
    expect(z40.kind).toBe('section');
    expect(z40.lat).toBeCloseTo(41.6088, 4);
    expect(z40.lng).toBeCloseTo(-0.915697, 5);
    expect(z40.endLat).toBeCloseTo(41.6192, 4);
    expect(z40.endLng).toBeCloseTo(-0.9496, 4);
    expect(z40.road).toBe('Z-40');
    expect(z40.source).toBe('dgt');
  });
  it('los puntuales no tienen fin y todos tienen coordenadas validas', () => {
    const fixed = radares.filter((r) => r.kind === 'fixed');
    expect(fixed.length).toBeGreaterThan(0);
    for (const r of radares) {
      expect(Number.isFinite(r.lat) && Number.isFinite(r.lng)).toBe(true);
      if (r.kind === 'fixed') expect(r.endLat).toBeUndefined();
      expect(['positive', 'negative', 'both', 'unknown']).toContain(r.direction ?? 'unknown');
    }
  });
});
