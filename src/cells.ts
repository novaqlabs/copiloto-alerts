/** Celdas de un grado para las capas oficiales (spec §4): `${floor(lat)}_${floor(lng)}`. */
export const CELL_BOUNDS = { minLat: 27, maxLat: 44, minLng: -19, maxLng: 5 } as const;

export function cellOf(lat: number, lng: number): string {
  return `${Math.floor(lat)}_${Math.floor(lng)}`;
}

export function inCoverage(lat: number, lng: number): boolean {
  return lat >= CELL_BOUNDS.minLat && lat < CELL_BOUNDS.maxLat + 1 && lng >= CELL_BOUNDS.minLng && lng < CELL_BOUNDS.maxLng + 1;
}
