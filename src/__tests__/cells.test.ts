import { describe, expect, it } from 'vitest';
import { cellOf, inCoverage, CELL_BOUNDS } from '../cells.ts';

describe('cellOf', () => {
  it('usa floor, no round, en ambos ejes', () => {
    expect(cellOf(40.4168, -3.7038)).toBe('40_-4');
    expect(cellOf(40.9999, -3.0001)).toBe('40_-4');
    expect(cellOf(41.0, -3.0)).toBe('41_-3');
  });
  it('cubre Canarias y Portugal', () => {
    expect(cellOf(28.1, -15.4)).toBe('28_-16');
    expect(cellOf(38.7, -9.1)).toBe('38_-10');
  });
  it('inCoverage acota a la caja del spec', () => {
    expect(CELL_BOUNDS).toEqual({ minLat: 27, maxLat: 44, minLng: -19, maxLng: 5 });
    expect(inCoverage(40.4, -3.7)).toBe(true);
    expect(inCoverage(48.8, 2.3)).toBe(false);
    expect(inCoverage(35.0, 20.0)).toBe(false);
  });
});
