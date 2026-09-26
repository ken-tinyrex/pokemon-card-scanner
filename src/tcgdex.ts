// Looks up the scanned card on TCGdex (https://tcgdex.dev) for its type, set and artwork.

import { fuzzyFind, type Detection } from './match';
import { squash, words } from './pokedex';

const API = 'https://api.tcgdex.net/v2/en';

interface CardBrief {
  id: string;
  name: string;
  image?: string;
}

export interface CardInfo {
  id: string;
  name: string;
  /** Number within its set, as printed. */
  number: string;
  hp?: number;
  types: string[];
  set?: string;
  rarity?: string;
  /** Card image URL without size, if TCGdex has one; see cardImage(). */
  image?: string;
}

/** TCGdex serves each card image in two sizes: `low` (~250px wide) and `high` (~600px). */
export function cardImage(base: string, size: 'low' | 'high'): string {
  return `${base}/${size}.webp`;
}

async function getJson<T>(url: string, retries = 1): Promise<T> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`TCGdex responded ${res.status}`);
    return await res.json();
  } catch (err) {
    // TCGdex occasionally fails a request (without CORS headers); one retry usually succeeds.
    if (retries <= 0) throw err;
    await new Promise((r) => setTimeout(r, 400));
    return getJson(url, retries - 1);
  }
}

async function searchCards(name: string, hp?: number): Promise<CardBrief[]> {
  const params = new URLSearchParams({ name: `like:${name}`, 'pagination:itemsPerPage': '100' });
  if (hp) params.set('hp', `eq:${hp}`);
  return getJson(`${API}/cards?${params}`);
}

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
function closestByTitle(cards: CardBrief[], title: string): CardBrief | undefined {
  const text = squash(title);
  const tokens = words(title);
  let best: CardBrief | undefined;
  let bestScore = -Infinity;
  for (const card of cards) {
    const score = nameScore(card.name, text, tokens) + (card.image ? 0.5 : 0);
    if (score > bestScore) {
      best = card;
      bestScore = score;
    }
  }
  return best;
}

export async function findCard(detection: Detection): Promise<CardInfo | null> {
  const { species, form, hp, title, context } = detection;
  let cards = hp ? await searchCards(species.name, hp) : [];
  if (cards.length === 0) cards = await searchCards(species.name);
  // The detected form fills in words OCR may have missed ("Heat" Rotom); G-Max forms are VMAX cards.
  const formHints = `${form.name} ${form.formName === 'gmax' ? 'VMAX' : ''}`;
  // Skip TCG Pocket (digital) cards: we're scanning physical ones, and their images often don't load.
  const physical = cards.filter((c) => !c.image?.includes('/tcgp/'));
  const brief = closestByTitle(physical, `${title} ${context} ${formHints}`);
  if (!brief) return null;

  const card = await getJson<{
    id: string;
    localId: string;
    name: string;
    hp?: number;
    types?: string[];
    rarity?: string;
    image?: string;
    set?: { name?: string };
  }>(`${API}/cards/${encodeURIComponent(brief.id)}`);

  return {
    id: card.id,
    name: card.name,
    number: card.localId,
    hp: card.hp,
    types: card.types ?? [],
    set: card.set?.name,
    rarity: card.rarity,
    image: card.image,
  };
}

export interface CardVariant {
  id: string;
  name: string;
  /** Number within its set, as printed ("4", "SV107", "TG05"). */
  number: string;
  image: string;
  setName?: string;
}

interface SetBrief {
  id: string;
  name: string;
}

let setsPromise: Promise<SetBrief[]> | null = null;

/** All sets, oldest first (TCGdex lists them in release order). */
function loadSets(): Promise<SetBrief[]> {
  setsPromise ??= getJson<SetBrief[]>(`${API}/sets`).catch((err) => {
    setsPromise = null;
    throw err;
  });
  return setsPromise;
}

const variantsCache = new Map<number, Promise<CardVariant[]>>();

/**
 * Every physical card printed for a Pokémon (by National Pokédex number), newest set first.
 * Includes cards like "Ash's Pikachu" or "Mewtwo & Mew GX"; skips cards without artwork.
 */
export function cardsForSpecies(dexId: number): Promise<CardVariant[]> {
  let promise = variantsCache.get(dexId);
  if (!promise) {
    promise = (async () => {
      const [cards, sets] = await Promise.all([
        getJson<(CardBrief & { localId: string })[]>(`${API}/cards?dexId=eq:${dexId}&pagination:itemsPerPage=1000`),
        loadSets().catch(() => [] as SetBrief[]),
      ]);
      const order = new Map(sets.map((set, i) => [set.id, i]));
      const names = new Map(sets.map((set) => [set.id, set.name]));
      return cards
        .filter((c): c is CardBrief & { localId: string; image: string } => !!c.image && !c.image.includes('/tcgp/'))
        .map((c) => {
          // Card ids are "<set id>-<number>", e.g. "swsh4-44".
          const setId = c.id.slice(0, -(c.localId.length + 1));
          return { id: c.id, name: c.name, number: c.localId, image: c.image, setId, setName: names.get(setId) };
        })
        .sort(
          (a, b) =>
            (order.get(b.setId) ?? -1) - (order.get(a.setId) ?? -1) ||
            a.number.localeCompare(b.number, undefined, { numeric: true }),
        )
        .map(({ setId: _setId, ...variant }) => variant);
    })();
    promise.catch(() => variantsCache.delete(dexId));
    variantsCache.set(dexId, promise);
  }
  return promise;
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
