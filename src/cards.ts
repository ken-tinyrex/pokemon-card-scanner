// Printed-card data: the scanned card's type, set and artwork, and every card printed for a
// Pokémon. TCGdex (https://tcgdex.dev) is the main source; pokemontcg.io is the fallback
// when TCGdex is unreachable, and also hosts sharper scans.

import { fuzzyFind, type Detection } from './match';
import { squash, words } from './pokedex';

export interface CardVariant {
  /** Id within its source ("swsh4-44"). */
  id: string;
  name: string;
  /** Number within its set, as printed ("4", "SV107", "TG05"). */
  number: string;
  setName?: string;
  images: {
    /** ~250px wide, for thumbnails. */
    small: string;
    /** 600–734px wide. */
    large: string;
  };
  /** Card era ("base", "swsh", "sv", …), which decides where the artwork window is. */
  series: string;
  /** Known when the source lists it with the card; otherwise see cardDetails(). */
  rarity?: string;
  holo?: boolean;
  /** TCGdex set id, used to find the sharper pokemontcg.io scan. */
  tcgdexSetId?: string;
}

export interface CardInfo extends CardVariant {
  hp?: number;
  types: string[];
}

/** Energy-type colours, used to tint the scene. */
export const TYPE_COLORS: Record<string, number> = {
  Grass: 0x5fbd58,
  Fire: 0xf2743a,
  Water: 0x4f9be8,
  Lightning: 0xf5cf2e,
  Psychic: 0xb46fd0,
  Fighting: 0xd0783c,
  Darkness: 0x6b6f86,
  Metal: 0xa3adb8,
  Fairy: 0xf08ad8,
  Dragon: 0xc9a227,
  Colorless: 0xd9d6cf,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Matching the scanned title to a printed card ----------

/**
 * How well a card name ("Charizard VMAX") matches the OCR'd text, word by word,
 * since labels like "VMAX" are often read on a separate line from the name.
 */
function nameScore(cardName: string, text: string, tokens: string[]): number {
  let score = 0;
  for (const word of words(cardName)) {
    const found = word.length <= 2 ? tokens.includes(word) : fuzzyFind(word, text) <= (word.length < 5 ? 0.4 : 1);
    score += found ? word.length : -2 * word.length;
  }
  return score;
}

/** The card whose full name best matches the OCR'd title band. */
function closestByTitle<T extends { name: string }>(cards: T[], title: string): T | undefined {
  const text = squash(title);
  const tokens = words(title);
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const card of cards) {
    const score = nameScore(card.name, text, tokens);
    if (score > bestScore) {
      best = card;
      bestScore = score;
    }
  }
  return best;
}

/** Everything OCR saw, plus words implied by the detected form ("Heat" Rotom; G-Max forms are VMAX cards). */
function titleText({ form, title, context }: Detection): string {
  return `${title} ${context} ${form.name} ${form.formName === 'gmax' ? 'VMAX' : ''}`;
}

// ---------- TCGdex ----------

const TCGDEX = 'https://api.tcgdex.net/v2/en';
// After TCGdex fails, go straight to the fallback for a while instead of waiting on it each time.
const TCGDEX_RETRY_AFTER_MS = 5 * 60 * 1000;
let tcgdexDownUntil = 0;

async function tcgdexJson<T>(path: string): Promise<T> {
  if (Date.now() < tcgdexDownUntil) throw new Error('TCGdex is unavailable');
  try {
    const res = await fetch(`${TCGDEX}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`TCGdex responded ${res.status}`);
    return await res.json();
  } catch (err) {
    tcgdexDownUntil = Date.now() + TCGDEX_RETRY_AFTER_MS;
    throw err;
  }
}

interface TcgdexBrief {
  id: string;
  localId: string;
  name: string;
  image?: string;
}

/** "https://assets.tcgdex.net/en/swsh/swsh4/44" → "swsh" */
const tcgdexSeries = (image: string) => image.split('/').at(-3) ?? '';

function fromTcgdex(card: TcgdexBrief & { image: string }, setName?: string): CardVariant {
  return {
    id: card.id,
    name: card.name,
    number: card.localId,
    setName,
    images: { small: `${card.image}/low.webp`, large: `${card.image}/high.webp` },
    series: tcgdexSeries(card.image),
    // Card ids are "<set id>-<number>", e.g. "swsh4-44".
    tcgdexSetId: card.id.slice(0, -(card.localId.length + 1)),
  };
}

// Skip TCG Pocket (digital) cards: we're scanning physical ones, and their images often don't load.
const isPhysical = (card: TcgdexBrief): card is TcgdexBrief & { image: string } =>
  !!card.image && !card.image.includes('/tcgp/');

async function tcgdexFindCard(detection: Detection): Promise<CardInfo | null> {
  const search = (hp?: number) => {
    const params = new URLSearchParams({ name: `like:${detection.species.name}`, 'pagination:itemsPerPage': '100' });
    if (hp) params.set('hp', `eq:${hp}`);
    return tcgdexJson<TcgdexBrief[]>(`/cards?${params}`);
  };
  let cards = detection.hp ? await search(detection.hp) : [];
  if (cards.length === 0) cards = await search();
  const brief = closestByTitle(cards.filter(isPhysical), titleText(detection));
  if (!brief) return null;

  const card = await tcgdexJson<{
    hp?: number;
    types?: string[];
    rarity?: string;
    set?: { name?: string };
    variants?: { holo?: boolean; normal?: boolean };
  }>(`/cards/${encodeURIComponent(brief.id)}`);
  return {
    ...fromTcgdex(brief, card.set?.name),
    hp: card.hp,
    types: card.types ?? [],
    rarity: card.rarity,
    holo: !!card.variants?.holo && !card.variants?.normal,
  };
}

interface TcgdexSet {
  id: string;
  name: string;
}

let tcgdexSets: Promise<TcgdexSet[]> | null = null;

/** All TCGdex sets, oldest first (it lists them in release order). */
function loadTcgdexSets(): Promise<TcgdexSet[]> {
  tcgdexSets ??= tcgdexJson<TcgdexSet[]>('/sets').catch((err) => {
    tcgdexSets = null;
    throw err;
  });
  return tcgdexSets;
}

async function tcgdexCardsForSpecies(dexId: number): Promise<CardVariant[]> {
  const [cards, sets] = await Promise.all([
    tcgdexJson<TcgdexBrief[]>(`/cards?dexId=eq:${dexId}&pagination:itemsPerPage=1000`),
    loadTcgdexSets().catch(() => [] as TcgdexSet[]),
  ]);
  const order = new Map(sets.map((set, i) => [set.id, i]));
  const names = new Map(sets.map((set) => [set.id, set.name]));
  return cards
    .filter(isPhysical)
    .map((card) => fromTcgdex(card, names.get(card.id.slice(0, -(card.localId.length + 1)))))
    .sort(
      (a, b) =>
        (order.get(b.tcgdexSetId!) ?? -1) - (order.get(a.tcgdexSetId!) ?? -1) ||
        a.number.localeCompare(b.number, undefined, { numeric: true }),
    );
}

// ---------- pokemontcg.io ----------

const PTCG = 'https://api.pokemontcg.io/v2';
const PTCG_IMAGES = 'https://images.pokemontcg.io';
const PTCG_FIELDS = 'id,name,number,hp,types,rarity,set,images';

/** pokemontcg.io's API fails about half the time (500/502), so every request retries. */
async function ptcgJson<T>(path: string, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(400 * attempt);
    try {
      const res = await fetch(`${PTCG}${path}`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`pokemontcg.io responded ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

interface PtcgCard {
  id: string;
  name: string;
  number: string;
  hp?: string;
  types?: string[];
  rarity?: string;
  set: { name: string; series: string; releaseDate: string };
  images: { small: string; large: string };
}

const PTCG_SERIES: Record<string, string> = {
  Base: 'base',
  Gym: 'gym',
  Neo: 'neo',
  'E-Card': 'ecard',
  EX: 'ex',
  POP: 'pop',
  'Diamond & Pearl': 'dp',
  Platinum: 'pl',
  'HeartGold & SoulSilver': 'hgss',
  'Black & White': 'bw',
  XY: 'xy',
  'Sun & Moon': 'sm',
  'Sword & Shield': 'swsh',
  'Scarlet & Violet': 'sv',
  'Mega Evolution': 'me',
};

function fromPtcg(card: PtcgCard): CardInfo {
  return {
    id: card.id,
    name: card.name,
    number: card.number,
    setName: card.set.name,
    images: card.images,
    series: PTCG_SERIES[card.set.series] ?? '',
    rarity: card.rarity,
    holo: /holo/i.test(card.rarity ?? ''),
    hp: card.hp ? Number(card.hp) : undefined,
    types: card.types ?? [],
  };
}

async function ptcgSearch(query: string): Promise<CardInfo[]> {
  const params = new URLSearchParams({ q: query, select: PTCG_FIELDS, pageSize: '250', orderBy: '-set.releaseDate' });
  const { data } = await ptcgJson<{ data: PtcgCard[] }>(`/cards?${params}`);
  return data
    .sort(
      (a, b) =>
        b.set.releaseDate.localeCompare(a.set.releaseDate) ||
        a.number.localeCompare(b.number, undefined, { numeric: true }),
    )
    .map(fromPtcg);
}

// Every card of a Pokémon in one request (slow: several seconds), shared by the scan lookup
// and the "all cards" gallery.
const ptcgSpeciesCache = new Map<number, Promise<CardInfo[]>>();

function ptcgCardsForSpecies(dexId: number): Promise<CardInfo[]> {
  let promise = ptcgSpeciesCache.get(dexId);
  if (!promise) {
    promise = ptcgSearch(`nationalPokedexNumbers:${dexId}`);
    promise.catch(() => ptcgSpeciesCache.delete(dexId));
    ptcgSpeciesCache.set(dexId, promise);
  }
  return promise;
}

async function ptcgFindCard(detection: Detection): Promise<CardInfo | null> {
  const cards = await ptcgCardsForSpecies(detection.species.id);
  const sameHp = cards.filter((c) => c.hp === detection.hp);
  return closestByTitle(sameHp.length > 0 ? sameHp : cards, titleText(detection)) ?? null;
}

// ---------- Public API: TCGdex first, pokemontcg.io if it fails ----------

async function withFallback<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await primary();
  } catch (err) {
    console.warn('TCGdex failed, using pokemontcg.io instead', err);
    return fallback();
  }
}

/** The printed card that best matches a scan, with its type, set and artwork. */
export function findCard(detection: Detection): Promise<CardInfo | null> {
  return withFallback(
    () => tcgdexFindCard(detection),
    () => ptcgFindCard(detection),
  );
}

const variantsCache = new Map<number, Promise<CardVariant[]>>();

/**
 * Every physical card printed for a Pokémon (by National Pokédex number), newest set first.
 * Includes cards like "Ash's Pikachu" or "Mewtwo & Mew GX".
 */
export function cardsForSpecies(dexId: number): Promise<CardVariant[]> {
  let promise = variantsCache.get(dexId);
  if (!promise) {
    promise = withFallback(
      () => tcgdexCardsForSpecies(dexId),
      () => ptcgCardsForSpecies(dexId),
    );
    promise.catch(() => variantsCache.delete(dexId));
    variantsCache.set(dexId, promise);
  }
  return promise;
}

export interface CardDetails {
  rarity?: string;
  /** Printed with holographic foil (some holos only say "Rare", e.g. Base Set Charizard). */
  holo: boolean;
}

const detailsCache = new Map<string, Promise<CardDetails>>();

/** Rarity and foil of a card; TCGdex lists these only on the card itself. */
export function cardDetails(card: CardVariant): Promise<CardDetails> {
  if (card.rarity !== undefined || !card.tcgdexSetId) {
    return Promise.resolve({ rarity: card.rarity, holo: !!card.holo });
  }
  let promise = detailsCache.get(card.id);
  if (!promise) {
    promise = tcgdexJson<{ rarity?: string; variants?: { holo?: boolean; normal?: boolean } }>(
      `/cards/${encodeURIComponent(card.id)}`,
    ).then((c) => ({ rarity: c.rarity, holo: !!c.variants?.holo && !c.variants?.normal }));
    promise.catch(() => detailsCache.delete(card.id));
    detailsCache.set(card.id, promise);
  }
  return promise;
}

// ---------- Sharper scans for TCGdex cards ----------

// pokemontcg.io hosts sharper scans (734×1024) than TCGdex (600×825). Its sets use different
// ids ("sv3pt5" for TCGdex "sv03.5"), so they are matched by name once and cached.
const PTCG_SETS_CACHE_KEY = 'ptcg-sets-v1';
const PTCG_SETS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function ptcgSets(): Promise<{ id: string; name: string }[]> {
  try {
    const cached = JSON.parse(localStorage.getItem(PTCG_SETS_CACHE_KEY) ?? 'null');
    if (cached && Date.now() - cached.savedAt < PTCG_SETS_CACHE_TTL_MS) return cached.sets;
  } catch {
    // No usable cache.
  }
  const { data: sets } = await ptcgJson<{ data: { id: string; name: string }[] }>('/sets?select=id,name&pageSize=250');
  try {
    localStorage.setItem(PTCG_SETS_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), sets }));
  } catch {
    // Not cached; fetched again next visit.
  }
  return sets;
}

let ptcgSetMap: Promise<Map<string, string>> | null = null;

/** TCGdex set id → pokemontcg.io set id, matched by id or by set name. */
function loadPtcgSetMap(): Promise<Map<string, string>> {
  const squashName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
  ptcgSetMap ??= Promise.all([ptcgSets(), loadTcgdexSets()])
    .then(([ptcg, tcgdex]) => {
      const ids = new Set(ptcg.map((s) => s.id));
      const byName = new Map(ptcg.map((s) => [squashName(s.name), s.id]));
      const map = new Map<string, string>();
      for (const set of tcgdex) {
        const id = ids.has(set.id) ? set.id : byName.get(squashName(set.name));
        if (id) map.set(set.id, id);
      }
      return map;
    })
    .catch((err) => {
      ptcgSetMap = null;
      throw err;
    });
  return ptcgSetMap;
}

/** Starts loading the pokemontcg.io set list early, so sharp scans are ready when needed. */
export function prefetchHiresImages() {
  loadPtcgSetMap().catch(() => {});
}

/**
 * The sharpest scan of a card if it's better than `images.large`: the pokemontcg.io scan
 * (734×1024) for TCGdex cards whose set is known there. The newest sets may not be uploaded
 * yet, so callers should treat load errors as "none".
 */
export async function hiresImage(card: CardVariant): Promise<string | null> {
  if (!card.tcgdexSetId) return null; // pokemontcg.io cards already have it as images.large.
  try {
    const ptcgSet = (await loadPtcgSetMap()).get(card.tcgdexSetId);
    if (!ptcgSet) return null;
    const number = card.number.replace(/^0+(?=\w)/, ''); // "006" → "6"
    return `${PTCG_IMAGES}/${ptcgSet}/${number}_hires.png`;
  } catch {
    return null;
  }
}
