import { readFileSync } from 'node:fs';

/** Familias de tipos de alerta admitidas por el contrato v1. */
export type Family = 'police' | 'radars' | 'hazards' | 'traffic' | 'weather' | 'price';

export interface Subtype {
  key: string;
  name: string;
}

export interface VoiceSpec {
  /** Obligatorio salvo `priority = 0`. `{distance}` lo rellena el motor con `spokenDistance`. */
  announce?: string;
  /** Variante opcional con `{limit}`, solo para radares con velocidad conocida. */
  announceWithLimit?: string;
  near?: string;
  synonyms: string[];
}

export interface AlertTypeDef {
  key: string;
  name: string;
  family: Family;
  icon: string;
  color: string;
  enabled: boolean;
  ttlMin: number;
  extendMin: number;
  priority: number;
  /** Tipos que solo vienen de la DGT: no se ofrecen en la hoja de reporte del usuario. */
  official?: boolean;
  voice: VoiceSpec;
  subtypes: Subtype[];
}

export interface Catalogo {
  version: number;
  types: AlertTypeDef[];
}

const FAMILIES: ReadonlySet<Family> = new Set(['police', 'radars', 'hazards', 'traffic', 'weather', 'price']);

/**
 * Lee `catalogo.json` (raíz del repo). Es síncrono a propósito: se usa tanto en el CLI
 * como en construcciones de salidas que no quieren lidiar con una promesa de por medio.
 */
export function loadCatalogo(path: string | URL = new URL('../catalogo.json', import.meta.url)): Catalogo {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text) as Catalogo;
}

export interface Validation {
  ok: boolean;
  problems: string[];
}

/** Comprueba las reglas del contrato v1: voz obligatoria salvo priority 0, claves únicas y family conocida. */
export function validateCatalogo(c: Catalogo): Validation {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const t of c.types) {
    if (seen.has(t.key)) problems.push(`clave repetida: ${t.key}`);
    seen.add(t.key);
    if (!FAMILIES.has(t.family)) problems.push(`family desconocida en "${t.key}": ${t.family}`);
    if (t.priority !== 0 && !t.voice?.announce) problems.push(`falta voice.announce en "${t.key}" (priority ${t.priority})`);
  }
  return { ok: problems.length === 0, problems };
}
