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
  hp?: number;
  types: string[];
  set?: string;
  rarity?: string;
  /** Small card image, if TCGdex has one. */
  image?: string;
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
    hp: card.hp,
    types: card.types ?? [],
    set: card.set?.name,
    rarity: card.rarity,
    image: card.image ? `${card.image}/low.webp` : undefined,
  };
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
