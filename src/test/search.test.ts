import { describe, expect, it } from 'vitest';
import { type ApiPokemon, buildCatalog } from '../pokedex';
import { buildSearchEntries, suggest } from '../search';
import fixture from './catalog.fixture.json';

const entries = buildSearchEntries(buildCatalog(fixture as ApiPokemon[]));
const labels = (text: string, limit?: number) => suggest(entries, text, limit).map((e) => e.label);

describe('suggest', () => {
  it('puts names starting with the query first, base Pokémon before forms', () => {
    expect(labels('char', 3)).toEqual(['Charmander', 'Charmeleon', 'Charizard']);
    expect(labels('char')).toContain('Mega Charizard X');
  });

  it('matches partial names', () => {
    expect(labels('pika')[0]).toBe('Pikachu');
  });

  it('finds regional forms by region or by species', () => {
    expect(labels('alolan vul')).toEqual(['Alolan Vulpix']);
    expect(labels('vulpix')).toEqual(['Vulpix', 'Alolan Vulpix']);
  });

  it('ignores case, accents and punctuation', () => {
    expect(labels('mr mime')[0]).toBe('Mr. Mime');
    expect(labels('flabebe')[0]).toBe('Flabébé');
  });

  it('tolerates small misspellings', () => {
    expect(labels('pikachoo')[0]).toBe('Pikachu');
    expect(labels('charizrd')[0]).toBe('Charizard');
  });

  it('returns nothing for empty or unknown queries', () => {
    expect(labels('')).toEqual([]);
    expect(labels('zzzzqq')).toEqual([]);
  });

  it('limits the number of suggestions', () => {
    expect(labels('a', 5)).toHaveLength(5);
  });
});
