import { describe, expect, it } from 'vitest';
import { loadCatalogo, validateCatalogo, type Catalogo } from '../catalogo.ts';

const base = {
  name: 'X', family: 'hazards' as const, icon: 'i', color: '#000000', enabled: true,
  ttlMin: 1, extendMin: 1, voice: { synonyms: [] }, subtypes: [],
};

describe('loadCatalogo', () => {
  it('lee catalogo.json con los 10 tipos del contrato v1', () => {
    const c = loadCatalogo();
    expect(c.version).toBe(1);
    expect(c.types.length).toBe(10);
    expect(c.types.map((t) => t.key)).toContain('fixed_camera');
  });
});

describe('validateCatalogo', () => {
  it('el catalogo real no tiene problemas', () => {
    expect(validateCatalogo(loadCatalogo())).toEqual({ ok: true, problems: [] });
  });

  it('detecta un tipo sin voice.announce con priority distinta de 0', () => {
    const c: Catalogo = { version: 1, types: [{ key: 'x', priority: 2, ...base }] };
    const r = validateCatalogo(c);
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it('no exige voice.announce cuando priority es 0', () => {
    const c: Catalogo = { version: 1, types: [{ key: 'x', priority: 0, ...base }] };
    expect(validateCatalogo(c)).toEqual({ ok: true, problems: [] });
  });

  it('detecta dos claves repetidas', () => {
    const t = { key: 'x', priority: 0, ...base };
    const c: Catalogo = { version: 1, types: [t, t] };
    const r = validateCatalogo(c);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes('repetida'))).toBe(true);
  });

  it('detecta una family desconocida', () => {
    const c: Catalogo = { version: 1, types: [{ ...base, key: 'x', priority: 0, family: 'unknown' as Catalogo['types'][number]['family'] }] };
    const r = validateCatalogo(c);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.includes('family'))).toBe(true);
  });
});
