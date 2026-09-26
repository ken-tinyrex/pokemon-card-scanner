import { describe, expect, it } from 'vitest';
import { artWindow, foilFor } from '../holo';

describe('foilFor', () => {
  it.each([
    ['Common', false, 'none'],
    ['Uncommon', false, 'none'],
    ['Rare', false, 'none'],
    // Base Set Charizard: rarity "Rare", printed holo.
    ['Rare', true, 'holo'],
    ['Rare Holo', false, 'holo'],
    ['Holo Rare', false, 'holo'],
    ['Holo Rare V', true, 'full'],
    ['Holo Rare VMAX', true, 'full'],
    ['Holo Rare VSTAR', true, 'full'],
    ['Double rare', true, 'full'],
    ['Ultra Rare', true, 'full'],
    ['Illustration rare', true, 'full'],
    ['Special illustration rare', true, 'full'],
    ['Radiant Rare', true, 'full'],
    ['Rare Holo LV.X', true, 'full'],
    ['Hyper rare', true, 'gold'],
    ['Mega Hyper Rare', true, 'gold'],
    ['Crown', true, 'gold'],
    [undefined, false, 'none'],
  ] as const)('%s (holo print: %s) → %s', (rarity, holo, foil) => {
    expect(foilFor(rarity, holo)).toBe(foil);
  });
});

describe('artWindow', () => {
  it('picks the art window by card era', () => {
    expect(artWindow('https://assets.tcgdex.net/en/base/base1/4').bottom).toBe(52);
    expect(artWindow('https://assets.tcgdex.net/en/swsh/swsh4/44').bottom).toBe(46.5);
    expect(artWindow('https://assets.tcgdex.net/en/sv/sv03.5/006').bottom).toBe(44);
  });
});
