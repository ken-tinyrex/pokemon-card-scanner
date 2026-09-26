// Turns OCR'd text lines from a card's title area into a species + form.

import { type Form, type Species, shinyOf, squash, words } from './pokedex';

export interface OcrLine {
  text: string;
  /** Text size of the line in pixels; the card name is the largest text in the title band. */
  height: number;
}

export interface Detection {
  species: Species;
  form: Form;
  /** The OCR line the name was read from. */
  title: string;
  /** All title-band text, minus "Evolves from…" (for form labels on their own line). */
  context: string;
  hp?: number;
  /** Edit distance between the species name and the OCR text (0 = exact). */
  distance: number;
  score: number;
}

// Characters OCR commonly mixes up cost less than a real mismatch.
const CONFUSABLE = new Set(['il', 'li', 'l1', '1l', 'i1', '1i', 'o0', '0o', 's5', '5s', 'b8', '8b', 'z2', '2z', 'g9', '9g', 'rn', 'nr']);
const CONFUSABLE_COST = 0.4;

/** Minimum edit distance between `pattern` and any substring of `text` (Sellers' algorithm). */
export function fuzzyFind(pattern: string, text: string): number {
  const m = pattern.length;
  let prev = new Float32Array(m + 1);
  let cur = new Float32Array(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;
  let best = prev[m];
  for (const ch of text) {
    cur[0] = 0;
    for (let i = 1; i <= m; i++) {
      const p = pattern[i - 1];
      const sub = p === ch ? 0 : CONFUSABLE.has(p + ch) ? CONFUSABLE_COST : 1;
      cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + sub);
    }
    best = Math.min(best, cur[m]);
    [prev, cur] = [cur, prev];
  }
  return best;
}

function allowedDistance(length: number): number {
  if (length <= 4) return CONFUSABLE_COST;
  if (length <= 6) return 1;
  return length * 0.25;
}

// How card titles spell each API form. Each inner array is a group of alternatives.
const FORM_NAME_KEYWORDS: Record<string, string[]> = {
  mega: ['mega', 'm'],
  xy: ['mega', 'm'],
  gmax: ['gmax', 'vmax', 'gigantamax'],
  alolan: ['alolan'],
  galar: ['galarian'],
  hisuian: ['hisuian'],
  primal: ['primal'],
  origin: ['origin'],
};

const FORM_OVERRIDES: Record<string, string[][]> = {
  "Ash's Greninja": [['ashgreninja', 'ashs']],
  'Armoured Mewtwo': [['armored', 'armoured']],
  'Eternamax Eternatus': [['eternamax', 'vmax']],
};

const STOPWORDS = new Set(['form', 'forme', 'breed', 'shiny', 'the', 'of']);
const SHINY_KEYWORDS = ['radiant', 'shining', 'shiny'];

export function formKeywordGroups(species: Species, form: Form): string[][] {
  const override = FORM_OVERRIDES[form.name];
  if (override) return override;
  const groups: string[][] = [];
  const synonyms = FORM_NAME_KEYWORDS[form.formName];
  if (synonyms) groups.push(synonyms);
  const speciesWords = new Set(words(species.name));
  for (const w of words(form.name)) {
    if (speciesWords.has(w) || STOPWORDS.has(w) || synonyms?.includes(w)) continue;
    groups.push([w]);
  }
  return groups;
}

function hasKeyword(keyword: string, tokens: string[], title: string, context: string): boolean {
  if (keyword.length <= 2) return tokens.includes(keyword);
  if (keyword.length < 4) return fuzzyFind(keyword, title) <= CONFUSABLE_COST;
  // Longer keywords may also sit on their own line, like the "VMAX" label beside the name.
  return Math.min(fuzzyFind(keyword, title), fuzzyFind(keyword, context)) <= 1;
}

/**
 * Pick the form whose keywords best match the title; falls back to the species default.
 * `context` is the rest of the title-band text, searched for longer keywords only.
 */
export function detectForm(species: Species, title: string, context = ''): Form {
  const tokens = words(title);
  const squashed = squash(title);
  const squashedContext = squash(context);
  let best = species.defaultForm;
  let bestRatio = 0;
  let bestHits = 0;
  for (const form of species.forms) {
    if (form.shiny) continue;
    const groups = formKeywordGroups(species, form);
    if (groups.length === 0) continue;
    const hits = groups.filter((g) => g.some((k) => hasKeyword(k, tokens, squashed, squashedContext))).length;
    const ratio = hits / groups.length;
    if (hits > 0 && (ratio > bestRatio || (ratio === bestRatio && hits > bestHits))) {
      best = form;
      bestRatio = ratio;
      bestHits = hits;
    }
  }
  // "Radiant"/"Shining" cards show shiny Pokémon; use the shiny model when there is one.
  const shiny = SHINY_KEYWORDS.some((k) => hasKeyword(k, tokens, squashed, squashedContext));
  const shinyForm = shiny ? shinyOf(species, best) : undefined;
  return shinyForm?.available ? shinyForm : best;
}

/**
 * Drops "Evolves from X" so a Stage 1 card isn't read as its pre-evolution.
 * OCR often splits "Evolves" and "from X" onto separate lines, so cut at either word.
 */
export function stripEvolvesFrom(text: string): string {
  return text.replace(/(\S*(lves|volv)|\b[ft]r[o0a]m|\bput\b)[\s\S]*$/i, '').trim();
}

// Card names have at most a couple of lowercase words ("ex"); rules and attack text have many.
const MAX_LOWERCASE_WORDS = 3;

function isProse(text: string): boolean {
  return text.split(/\s+/).filter((w) => /^[a-z]{3,}[.,]?$/.test(w)).length > MAX_LOWERCASE_WORDS;
}

const isHp = (n: number) => n >= 30 && n <= 400 && n % 10 === 0;

/**
 * HP from "HP 120" / "120 HP". With `loose`, also the last round number on the line,
 * since the small "HP" glyph is often misread (used for the title line only).
 */
export function parseHp(text: string, loose = true): number | undefined {
  const m = text.match(/hp\s*(\d{2,3})|(\d{2,3})\s*hp/i);
  if (m && isHp(Number(m[1] ?? m[2]))) return Number(m[1] ?? m[2]);
  if (!loose) return undefined;
  const numbers = [...text.matchAll(/(\d{2,3})(?!\d)/g)].map((n) => Number(n[1])).filter(isHp);
  return numbers.at(-1);
}

export interface DetectOptions {
  /** Only accept near-exact matches (for text from the whole card, not just the title). */
  strict?: boolean;
}

/**
 * VMAX and VSTAR cards say "Evolves from Pikachu V": the same species as the card.
 * Their stylised titles often defeat OCR, so this line is a useful backup.
 */
export function vEvolutionName(text: string): string | null {
  const m = text.match(/[ft]r[o0a]m\s*([A-Za-z.' -]+?)\s*V\b/);
  return m ? m[1].trim() : null;
}

const V_EVOLUTION_WEIGHT = 0.5;

export function detectFromLines(lines: OcrLine[], catalog: Species[], { strict = false }: DetectOptions = {}): Detection | null {
  const maxHeight = Math.max(1, ...lines.map((l) => l.height));
  const candidates = lines.map((line) => ({ text: stripEvolvesFrom(line.text), weight: line.height / maxHeight }));
  for (const line of lines) {
    const name = vEvolutionName(line.text);
    if (name) candidates.push({ text: name, weight: V_EVOLUTION_WEIGHT });
  }
  let best: Detection | null = null;
  for (const { text, weight } of candidates) {
    if (isProse(text)) continue;
    const squashed = squash(text);
    if (squashed.length < 3) continue;
    for (const species of catalog) {
      const distance = fuzzyFind(species.key, squashed);
      const allowed = strict ? Math.min(1, allowedDistance(species.key.length)) : allowedDistance(species.key.length);
      if (distance > allowed || (strict && distance > 0 && species.key.length < 5)) continue;
      // The name is the largest text in the title band; "Evolves from X" is small.
      const score = (species.key.length - 2 * distance) * weight;
      if (!best || score > best.score) {
        best = { species, form: species.defaultForm, title: text, context: '', distance, score };
      }
    }
  }
  if (!best) return null;
  best.context = lines.map((l) => stripEvolvesFrom(l.text)).join(' ');
  best.form = detectForm(best.species, best.title, best.context);
  best.hp = parseHp(best.title) ?? lines.map((l) => parseHp(l.text, false)).find((hp) => hp !== undefined);
  return best;
}

/**
 * Combines detections from several OCR passes: the species with the most total score wins.
 * `extraContext` is text from passes that found no name but may hold a form label ("VMAX").
 */
export function mergeDetections(detections: Detection[], extraContext = ''): Detection | null {
  const bySpecies = new Map<number, Detection[]>();
  for (const d of detections) {
    bySpecies.set(d.species.id, [...(bySpecies.get(d.species.id) ?? []), d]);
  }
  let winner: Detection[] | null = null;
  let winnerScore = -Infinity;
  for (const group of bySpecies.values()) {
    const total = group.reduce((sum, d) => sum + d.score, 0);
    if (total > winnerScore) {
      winner = group;
      winnerScore = total;
    }
  }
  if (!winner) return null;
  const top = winner.reduce((a, b) => (b.score > a.score ? b : a));
  // Each pass may catch a different part of the title ("Heat" in one, "Rotom" in another).
  const titles = winner.map((d) => d.title).join(' ');
  const context = [...winner.map((d) => d.context), extraContext].join(' ');
  return {
    ...top,
    context,
    form: detectForm(top.species, titles, context),
    hp: winner.find((d) => d.hp !== undefined)?.hp,
    distance: Math.min(...winner.map((d) => d.distance)),
    score: winnerScore,
  };
}
