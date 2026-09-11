/**
 * CLI de copiloto-alerts.
 *
 *   node src/cli.ts run --out <dir> [--skip-supabase] [--radares <url|fichero>] [--incidencias <url|fichero>]
 *                       [--detectores-medidas <url|fichero>] [--detectores-ubicaciones <url|fichero>]
 *                       [--prev-meta <url|fichero>]
 *
 * Variables de entorno (solo se leen en GitHub Actions; nunca hardcodeadas):
 *   SUPABASE_URL, SUPABASE_SECRET_KEY
 *
 * NOTA: URL del NAP verificadas el 2026-09-08; el catálogo de datasets está en
 * https://nap.dgt.es/dataset/radares-fijos-dgt y
 * https://nap.dgt.es/dataset/incidencias-dgt-datex2-v3-7
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { loadCatalogo, validateCatalogo } from './catalogo.ts';
import { parseRadares, type Radar } from './radares.ts';
import { parseIncidencias, type Incidencia } from './incidencias.ts';
import { buildOutputs, writeOutputs, type SourceMeta, type SourcesMeta } from './outputs.ts';
import { cleanupTraces, syncReportTypes, type SupabaseEnv } from './supabase.ts';
import { isDailyMaintenanceWindow } from './schedule.ts';
import {
  bearingForDetectors,
  buildTrafficSites,
  parseDetectorLocations,
  parseDetectorMeasurements,
  publicationTimeOf,
  type TrafficSite,
} from './detectores.ts';

const DEFAULT_RADARES_URL = 'http://infocar.dgt.es/datex2/dgt/PredefinedLocationsPublication/radares/content.xml';
const DEFAULT_INCIDENCIAS_URL = 'https://nap.dgt.es/datex2/v3/dgt/SituationPublication/datex2_v37.xml';
const DEFAULT_DETECTORES_MEDIDAS_URL = 'http://infocar.dgt.es/datex2/dgt/MeasuredDataPublication/detectores/content.xml';
const DEFAULT_DETECTORES_UBICACIONES_URL = 'http://infocar.dgt.es/datex2/dgt/PredefinedLocationsPublication/detectores/content.xml';

const USER_AGENT = 'copiloto-alerts/1.0 (+https://buscagasolina.com)';
const FETCH_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 10_000;

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : def;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchOnce(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Lee un fichero local si `source` existe en disco; si no, lo trata como URL con un reintento tras 10 s. */
async function readSource(source: string): Promise<string> {
  if (existsSync(source)) return readFile(source, 'utf8');
  try {
    return await fetchOnce(source);
  } catch (e) {
    log(`reintento tras fallo (${e instanceof Error ? e.message : e})`);
    await sleep(RETRY_DELAY_MS);
    return fetchOnce(source);
  }
}

interface PrevMeta {
  sources?: {
    radares?: { fetchedAt?: string };
    incidencias?: { fetchedAt?: string };
    trafico?: { fetchedAt?: string };
  };
}

async function loadPrevMeta(source: string | undefined): Promise<PrevMeta | undefined> {
  if (!source) return undefined;
  try {
    const text = existsSync(source) ? await readFile(source, 'utf8') : await fetchOnce(source);
    return JSON.parse(text) as PrevMeta;
  } catch (e) {
    log(`prev-meta: no se pudo leer (${e instanceof Error ? e.message : e}), se ignora`);
    return undefined;
  }
}

async function loadSource(
  name: 'radares' | 'incidencias' | 'trafico',
  source: string,
  now: Date,
  prevMeta: PrevMeta | undefined,
): Promise<{ text?: string; meta: SourceMeta }> {
  try {
    const text = await readSource(source);
    return { text, meta: { fetchedAt: now.toISOString(), records: 0, ok: true } };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`${name}: fallo (${error})`);
    const fetchedAt = prevMeta?.sources?.[name]?.fetchedAt ?? now.toISOString();
    return { meta: { fetchedAt, records: 0, ok: false, error } };
  }
}

function supabaseEnvFromProcess(): SupabaseEnv | undefined {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  return url && secretKey ? { url, secretKey } : undefined;
}

async function run(): Promise<void> {
  const outDir = arg('out', 'out')!;
  const radaresSource = arg('radares', DEFAULT_RADARES_URL)!;
  const incidenciasSource = arg('incidencias', DEFAULT_INCIDENCIAS_URL)!;
  const medidasSource = arg('detectores-medidas', DEFAULT_DETECTORES_MEDIDAS_URL)!;
  const ubicacionesSource = arg('detectores-ubicaciones', DEFAULT_DETECTORES_UBICACIONES_URL)!;
  const prevMetaSource = arg('prev-meta');
  const skipSupabase = has('skip-supabase');
  const now = new Date();

  log(`inicio: radares=${radaresSource} incidencias=${incidenciasSource} salida=${outDir}`);

  const catalogo = loadCatalogo();
  const catalogoCheck = validateCatalogo(catalogo);
  if (!catalogoCheck.ok) {
    console.error(`ERROR: catalogo.json invalido: ${catalogoCheck.problems.join('; ')}`);
    process.exit(5);
  }

  const prevMeta = await loadPrevMeta(prevMetaSource);
  const [radaresRes, incidenciasRes, medidasRes] = await Promise.all([
    loadSource('radares', radaresSource, now, prevMeta),
    loadSource('incidencias', incidenciasSource, now, prevMeta),
    loadSource('trafico', medidasSource, now, prevMeta),
  ]);

  // Las ubicaciones (18,8 MB) van aparte: un fallo suyo no invalida radares ni incidencias, solo
  // deja la capa de trafico sin publicar en esta vuelta (la Task 2 las cachea 24 h en el estado).
  let ubicacionesText: string | undefined;
  try {
    ubicacionesText = await readSource(ubicacionesSource);
  } catch (e) {
    log(`detectores: fallo al leer las ubicaciones (${e instanceof Error ? e.message : e})`);
  }

  if (!radaresRes.text && !incidenciasRes.text) {
    console.error('ERROR: fallaron las dos fuentes, no se publica nada.');
    process.exit(4);
  }

  let radares: Radar[] = [];
  if (radaresRes.text) {
    radares = parseRadares(radaresRes.text);
    radaresRes.meta.records = radares.length;
    log(`radares: ${radares.length} registros`);
  }

  let incidencias: Incidencia[] = [];
  let discardedIncidencias: Record<string, number> = {};
  if (incidenciasRes.text) {
    const { items, discarded } = parseIncidencias(incidenciasRes.text, now);
    incidencias = items;
    discardedIncidencias = discarded;
    incidenciasRes.meta.records = items.length;
    const descartados = Object.values(discarded).reduce((a, b) => a + b, 0);
    log(`incidencias: ${items.length} registros (${descartados} descartados)`);
  }

  let trafico: TrafficSite[] = [];
  let traficoWithSpeed = 0;
  if (medidasRes.text && ubicacionesText) {
    const locations = parseDetectorLocations(ubicacionesText);
    const measurements = parseDetectorMeasurements(medidasRes.text);
    const publishedRaw = publicationTimeOf(medidasRes.text);
    const publishedMs = publishedRaw ? Date.parse(publishedRaw) : Number.NaN;
    const publishedAt = Number.isFinite(publishedMs) ? new Date(publishedMs) : now;
    trafico = buildTrafficSites({ locations, measurements, publishedAt, bearings: bearingForDetectors(locations) });
    traficoWithSpeed = trafico.filter((s) => s.speedKmh !== null).length;
    medidasRes.meta.records = trafico.length;
    log(`detectores: ${locations.length} ubicaciones, ${measurements.length} medidas, ${trafico.length} sitios (${traficoWithSpeed} con velocidad)`);
  } else if (medidasRes.text) {
    medidasRes.meta.ok = false;
    medidasRes.meta.error = 'sin ubicaciones de detectores';
  }

  const sources: SourcesMeta = {
    radares: radaresRes.meta,
    incidencias: incidenciasRes.meta,
    trafico: { ...medidasRes.meta, withSpeed: traficoWithSpeed },
  };
  const out = buildOutputs({ radares, incidencias, catalogo, now, sources, discardedIncidencias, trafico });
  const bytes = await writeOutputs(outDir, out);
  log(`escritos ${out.size} ficheros (${(bytes / 1000).toFixed(0)} KB) en ${outDir}`);

  if (skipSupabase) {
    log('supabase: --skip-supabase, se omite sincronizacion');
    return;
  }
  const env = supabaseEnvFromProcess();
  if (!env) {
    log('supabase: faltan SUPABASE_URL/SUPABASE_SECRET_KEY en el entorno, se omite sincronizacion');
    return;
  }

  // report_types (barato, pero firma con la clave secreta) y la limpieza de trazas (cara: lista
  // y borra por carpeta) solo hace falta sincronizarlos una vez al dia, no en cada ejecucion
  // cada 10 minutos: se hacen ambos en la misma ventana 04:00-04:09 UTC.
  if (isDailyMaintenanceWindow(now)) {
    try {
      const n = await syncReportTypes(catalogo, env);
      log(`supabase: report_types sincronizados (${n})`);
    } catch (e) {
      log(`supabase: fallo sincronizando report_types: ${e instanceof Error ? e.message : e}`);
    }
    try {
      const n = await cleanupTraces(env, now);
      log(`supabase: ${n} objetos de trazas antiguas eliminados`);
    } catch (e) {
      log(`supabase: fallo en la limpieza de trazas: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    log('supabase: fuera de la ventana diaria (04:00-04:09 UTC), se omiten report_types y la limpieza de trazas');
  }
}

async function main() {
  const cmd = process.argv[2] ?? 'run';
  if (cmd !== 'run') {
    console.error(`comando desconocido: "${cmd}" (solo se admite "run")`);
    process.exit(1);
  }
  await run();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
