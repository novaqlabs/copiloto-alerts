/** Genera los ficheros publicados a partir de las alertas ya parseadas (contrato v1). */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cellOf, inCoverage } from './cells.ts';
import type { Radar } from './radares.ts';
import type { Incidencia } from './incidencias.ts';
import type { Catalogo } from './catalogo.ts';
import type { TrafficSite } from './detectores.ts';
import type { TrafficHistorySite } from './estado.ts';
import type { UserTrafficSite } from './trazas.ts';

export const CONTRACT_VERSION = 1;

export interface SourceMeta {
  fetchedAt: string;
  records: number;
  ok: boolean;
  error?: string;
}

/** `sources.trafico` (spec §3.4): `records` son los sitios publicados y `withSpeed` los que traen velocidad. */
export interface TraficoSourceMeta extends SourceMeta {
  withSpeed: number;
}

/** `sources.traces` (spec §3.4, Task 3): ficheros de trayecto leidos y puntos agregados. */
export interface TracesSourceMeta {
  fetchedAt: string;
  files: number;
  points: number;
  ok: boolean;
  error?: string;
}

export interface SourcesMeta {
  radares: SourceMeta;
  incidencias: SourceMeta;
  trafico?: TraficoSourceMeta;
  traces?: TracesSourceMeta;
}

export interface MetaJson {
  contractVersion: number;
  generatedAt: string;
  sources: SourcesMeta;
  cells: { radares: string[]; incidencias: string[]; trafico: string[]; historico: string[]; usuarios: string[] };
  discarded: { outOfCoverage: number; byType: Record<string, number> };
}

export interface BuildOutputsInput {
  radares: Radar[];
  incidencias: Incidencia[];
  catalogo: Catalogo;
  now: Date;
  sources: SourcesMeta;
  /** Descartes de `parseIncidencias` por motivo (incluye los xsi:type desconocidos, spec §4); se
   * publican tal cual en `meta.json#discarded.byType`. Vacio si no se pasa. */
  discardedIncidencias?: Record<string, number>;
  /** Sitios de trafico en vivo (Task 1); vacio si el feed de detectores fallo. */
  trafico?: TrafficSite[];
  /** Perfiles horarios maduros (Task 2); vacio mientras ningun detector llegue a 20 muestras. */
  historico?: TrafficHistorySite[];
  /** Celdas de 100 m agregadas de los trayectos propios (Task 3); vacio sin Supabase configurado. */
  usuarios?: UserTrafficSite[];
  /** Estado acumulado (Task 2). Se publica tal cual en `trafico/estado.json`; la app no lo lee. */
  estado?: unknown;
}

export type OutputMap = Map<string, unknown>;

/** Reparte por celda de un grado (spec §4), descartando lo que cae fuera de la caja de cobertura. */
function groupByCell<T extends { id: string; lat: number; lng: number }>(items: T[]): { byCell: Map<string, T[]>; outOfCoverage: number } {
  const byCell = new Map<string, T[]>();
  let outOfCoverage = 0;
  for (const item of items) {
    if (!inCoverage(item.lat, item.lng)) {
      outOfCoverage++;
      continue;
    }
    const cell = cellOf(item.lat, item.lng);
    const arr = byCell.get(cell);
    if (arr) arr.push(item);
    else byCell.set(cell, [item]);
  }
  for (const arr of byCell.values()) arr.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { byCell, outOfCoverage };
}

export function buildOutputs(input: BuildOutputsInput): OutputMap {
  const { radares, incidencias, catalogo, now, sources, discardedIncidencias } = input;
  const out: OutputMap = new Map();

  const radarGroups = groupByCell(radares);
  const incGroups = groupByCell(incidencias);

  for (const [cell, items] of radarGroups.byCell) out.set(`radares/${cell}.json`, items);
  for (const [cell, items] of incGroups.byCell) out.set(`incidencias/${cell}.json`, items);

  const traficoGroups = groupByCell(input.trafico ?? []);
  for (const [cell, items] of traficoGroups.byCell) out.set(`trafico/${cell}.json`, items);

  const historicoGroups = groupByCell(input.historico ?? []);
  for (const [cell, items] of historicoGroups.byCell) out.set(`trafico/historico/${cell}.json`, items);

  const usuariosGroups = groupByCell(input.usuarios ?? []);
  for (const [cell, items] of usuariosGroups.byCell) out.set(`trafico/usuarios/${cell}.json`, items);
  if (input.estado !== undefined) out.set('trafico/estado.json', input.estado);

  const meta: MetaJson = {
    contractVersion: CONTRACT_VERSION,
    generatedAt: now.toISOString(),
    sources,
    cells: {
      radares: [...radarGroups.byCell.keys()].sort(),
      incidencias: [...incGroups.byCell.keys()].sort(),
      trafico: [...traficoGroups.byCell.keys()].sort(),
      historico: [...historicoGroups.byCell.keys()].sort(),
      usuarios: [...usuariosGroups.byCell.keys()].sort(),
    },
    discarded: { outOfCoverage: radarGroups.outOfCoverage + incGroups.outOfCoverage + traficoGroups.outOfCoverage, byType: discardedIncidencias ?? {} },
  };
  out.set('meta.json', meta);
  out.set('catalogo.json', catalogo);
  return out;
}

/** Escribe las salidas en `dir`, igual que en repostar-data: mkdir -p, JSON compacto, .nojekyll e index.html mínimo. */
export async function writeOutputs(dir: string, out: OutputMap): Promise<number> {
  let bytes = 0;
  for (const [rel, value] of out) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    const text = JSON.stringify(value);
    bytes += Buffer.byteLength(text);
    await writeFile(path, text);
  }
  await writeFile(join(dir, '.nojekyll'), '');
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>Copiloto alerts</title><p>Alertas oficiales de la DGT (radares, incidencias y trafico de detectores) para Copiloto. Ver <a href="meta.json">meta.json</a>.',
  );
  return bytes;
}
