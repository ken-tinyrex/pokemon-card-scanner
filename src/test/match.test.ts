import { describe, expect, it } from 'vitest';
import { type ApiPokemon, buildCatalog } from '../pokedex';
import { detectFromLines, fuzzyFind, type OcrLine, parseHp, stripEvolvesFrom } from '../match';
import fixture from './catalog.fixture.json';

const catalog = buildCatalog(fixture as ApiPokemon[]);

/** Simulates an OCR'd title band: the name line is the tallest. */
function detect(title: string, extra: OcrLine[] = []) {
  return detectFromLines([{ text: title, height: 40 }, ...extra], catalog);
}

describe('fuzzyFind', () => {
  it('finds exact and near substrings', () => {
    expect(fuzzyFind('pikachu', 'basicpikachuhp60')).toBe(0);
    expect(fuzzyFind('charizard', 'charlzardv')).toBeLessThan(1);
    expect(fuzzyFind('mewtwo', 'xyz')).toBeGreaterThan(3);
  });
});

describe('species detection', () => {
  it.each([
    ['Pikachu HP 60', 'Pikachu', 60],
    ['BASIC Charizard ex 330 HP', 'Charizard', 330],
    ['Charlzard VMAX HP330', 'Charizard', 330],
    ['Mr. Mime', 'Mr. Mime', undefined],
    ['Mime Jr.', 'Mime Jr.', undefined],
    ['Mewtwo GX', 'Mewtwo', undefined],
    ['Mew', 'Mew', undefined],
    ['Porygon-Z', 'Porygon-Z', undefined],
    ['Porygon2', 'Porygon2', undefined],
    ['Tapu Koko GX', 'Tapu Koko', undefined],
    ['Iron Valiant ex', 'Iron Valiant', undefined],
    ['Flabebe', 'Flabébé', undefined],
    ["Farfetch'd", "Farfetch'd", undefined],
    ['Type: Null', 'Type: Null', undefined],
  ])('%s → %s', (title, name, hp) => {
    const d = detect(title);
    expect(d?.species.name).toBe(name);
    expect(d?.hp).toBe(hp);
  });

  it('ignores the "Evolves from" line', () => {
    const d = detectFromLines(
      [
        { text: 'STAGE 1 Evolves from Charmander', height: 12 },
        { text: 'Charmeleon HP 90', height: 40 },
      ],
      catalog,
    );
    expect(d?.species.name).toBe('Charmeleon');
  });

  it('prefers the large title over small text', () => {
    const d = detectFromLines(
      [
        { text: 'Bulbasaur', height: 10 },
        { text: 'Squirtle 60HP', height: 40 },
      ],
      catalog,
    );
    expect(d?.species.name).toBe('Squirtle');
  });

  it('returns null for text without a Pokémon', () => {
    expect(detect('Professor Research')).toBeNull();
  });
});

describe('form detection', () => {
  it.each([
    ['Pikachu', 'Pikachu'],
    ['Alolan Vulpix', 'Alolan Vulpix'],
    ['Galarian Meowth', 'Galarian Meowth'],
    ['Alolan Meowth', 'Alolan Meowth'],
    ['Hisuian Growlithe', 'Hisuian Growlithe'],
    ['Galarian Mr. Mime', 'Galarian Mr. Mime'],
    ['Charizard VMAX', 'G-Max Charizard'],
    ['M Charizard EX', 'Mega Charizard X'],
    ['Mega Charizard Y ex', 'Mega Charizard Y'],
    ['Primal Kyogre EX', 'Kyogre'],
    ['Origin Forme Dialga V', 'Dialga (Origin)'],
    ['Heat Rotom', 'Rotom Heat'],
    ['Black Kyurem EX', 'Black Kyurem'],
    ['Ice Rider Calyrex VMAX', 'Calyrex (Ice Rider)'],
    ['Dusk Mane Necrozma GX', 'Necrozma (Dusk Mane)'],
    ['Ultra Necrozma GX', 'Ultra Necrozma'],
    ['Paldean Tauros', 'Paldean Tauros (aqua breed)'],
    ['Ash-Greninja', "Ash's Greninja"],
    ['Eternatus VMAX', 'Eternamax Eternatus'],
    ['Zygarde EX', 'Zygarde (50% form)'],
  ])('%s → %s', (title, formName) => {
    const d = detect(title);
    expect(d?.form.name).toBe(formName);
    expect(d?.form.shiny).toBe(false);
  });

  it.each([
    ['Radiant Charizard', 'Shiny Charizard'],
    ['Shining Magikarp', 'Shiny Magikarp'],
  ])('%s → %s', (title, formName) => {
    const d = detect(title);
    expect(d?.form.name).toBe(formName);
    expect(d?.form.shiny).toBe(true);
  });

  it('keeps the regional form when it has no shiny model', () => {
    expect(detect('Radiant Alolan Vulpix')?.form.name).toBe('Alolan Vulpix');
  });
});

describe('stripEvolvesFrom', () => {
  it.each([
    ['Evolves from Charmeleon\n\n', ''],
    ['El volves from Charmeleon\n', 'El'],
    ['Charizard 120 HP Evolves from Charmeleon', 'Charizard 120 HP'],
    ['fromPikachu V', ''],
    ['Furret Evolvesfrom Sentret', 'Furret'],
  ])('%j → %j', (input, output) => {
    expect(stripEvolvesFrom(input)).toBe(output);
  });
});

describe('model resolution', () => {
  const base = 'https://raw.githubusercontent.com/Pokemon-3D-api/assets/main/';
  const data: ApiPokemon[] = [
    {
      id: 128,
      forms: [
        { name: 'Tauros', formName: 'regular', model: `${base}models/opt/regular/128.glb` },
        { name: 'Paldean Tauros (aqua breed)', formName: 'multiform', model: `${base}models/opt/multiform/128.glb` },
        { name: 'Paldean Tauros (blaze breed)', formName: 'multiform', model: `${base}models/opt/multiform/128.glb` },
      ],
    },
    {
      id: 78,
      forms: [
        { name: 'Rapidash', formName: 'regular', model: `${base}models/opt/regular/78.glb` },
        { name: 'Galarian Rapidash', formName: 'galar', model: `${base}models/opt/galar/78.glb` },
      ],
    },
  ];
  const files = ['models/opt/regular/128.glb', 'models/opt/multiform/128-1.glb', 'models/opt/multiform/128-2.glb', 'models/opt/regular/78.glb'];
  const [tauros, rapidash] = buildCatalog(data, files);

  it('maps forms that share a URL to numbered files', () => {
    expect(tauros.forms.map((f) => f.model.split('/opt/')[1])).toEqual(['regular/128.glb', 'multiform/128-1.glb', 'multiform/128-2.glb']);
    expect(tauros.forms.every((f) => f.available)).toBe(true);
  });

  it('marks forms without a file as unavailable', () => {
    expect(rapidash.forms.map((f) => f.available)).toEqual([true, false]);
  });

  it('assumes everything exists without a file list', () => {
    expect(buildCatalog(data).every((s) => s.forms.every((f) => f.available))).toBe(true);
  });
});

describe('parseHp', () => {
  it.each([
    ['Charizard 120 HP', 120],
    ['Pikachu HP60', 60],
    ['& Charizard ©? 4330 0', 330],
    ['Charizard(5Y', undefined],
    ['NO. 037 Fox 2019', undefined],
  ])('%j → %s', (text, hp) => {
    expect(parseHp(text)).toBe(hp);
  });
});

describe('VMAX / VSTAR backup', () => {
  it('reads the species from "Evolves from X V" when the title is unreadable', () => {
    // Real OCR output from a Pikachu VMAX card.
    const d = detectFromLines(
      [
        { text: 'VMAX of re', height: 110 },
        { text: 'I) Evolves fromPikachuV £7 Ngan ~', height: 37 },
      ],
      catalog,
    );
    expect(d?.species.name).toBe('Pikachu');
    expect(d?.form.name).toBe('G-Max Pikachu');
  });

  it('keeps the regional form of a VSTAR', () => {
    const d = detectFromLines([{ text: "Evolves from Hisuian Zoroark V'", height: 20 }], catalog);
    expect(d?.form.name).toBe('Hisuian Zoroark');
  });

  it('ignores ordinary pre-evolutions', () => {
    expect(detectFromLines([{ text: 'Evolves from Vulpix', height: 20 }], catalog)).toBeNull();
  });

  it('lets a readable title win over the backup', () => {
    const d = detectFromLines(
      [
        { text: 'Charizard VMAX', height: 40 },
        { text: 'Evolves from Charizard V', height: 15 },
      ],
      catalog,
    );
    expect(d?.title).toBe('Charizard VMAX');
  });
});
