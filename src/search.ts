// Name suggestions for the manual search box.

import { fuzzyFind } from './match';
import { type Form, type Species, squash, words } from './pokedex';

export interface SearchEntry {
  /** What the user sees: "Charizard", "Mega Charizard X", "Alolan Vulpix". */
  label: string;
  species: Species;
  form: Form;
  key: string;
  words: string[];
}

/** One entry per species plus one per non-shiny alternate form. */
export function buildSearchEntries(catalog: Species[]): SearchEntry[] {
  const entries: SearchEntry[] = [];
  const seen = new Set<string>();
  for (const species of catalog) {
    for (const form of species.forms) {
      if (form.shiny) continue;
      const label = form === species.defaultForm ? species.name : form.name;
      const key = squash(label);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ label, species, form, key, words: words(label) });
    }
  }
  return entries;
}

const FUZZY_RANK = 3;

/**
 * Lower is better: the name starts with the query, then a word in it does ("char" →
 * "Mega Charizard X"), then it contains the query, then close misspellings ("pikachoo").
 */
function rank(entry: SearchEntry, query: string): number | null {
  if (entry.key.startsWith(query)) return 0;
  if (entry.words.some((w) => w.startsWith(query))) return 1;
  if (entry.key.includes(query)) return 2;
  if (query.length >= 4) {
    const distance = fuzzyFind(query, entry.key);
    if (distance <= (query.length >= 7 ? 2 : 1)) return FUZZY_RANK + distance;
  }
  return null;
}

export function suggest(entries: SearchEntry[], text: string, limit = 8): SearchEntry[] {
  const query = squash(text);
  if (!query) return [];
  const ranked = entries
    .map((entry) => ({ entry, rank: rank(entry, query) }))
    .filter((r): r is { entry: SearchEntry; rank: number } => r.rank !== null);
  // Misspelling matches only fill in when nothing matches the text directly.
  const direct = ranked.filter((r) => r.rank < FUZZY_RANK);
  return (direct.length > 0 ? direct : ranked)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        // Base Pokémon before their alternate forms, then by Pokédex number.
        Number(a.entry.form !== a.entry.species.defaultForm) - Number(b.entry.form !== b.entry.species.defaultForm) ||
        a.entry.species.id - b.entry.species.id,
    )
    .slice(0, limit)
    .map((r) => r.entry);
}
