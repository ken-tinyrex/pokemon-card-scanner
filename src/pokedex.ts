// Loads the Pokémon 3D API catalog and indexes it by species and form.

const API_URL = 'https://pokemon-3d-api.onrender.com/v1/pokemon';
// The API lists some models that were never uploaded, so check against the real files.
const ASSETS_TREE_URL = 'https://api.github.com/repos/Pokemon-3D-api/assets/git/trees/main?recursive=1';
const ASSETS_BASE_URL = 'https://raw.githubusercontent.com/Pokemon-3D-api/assets/main/';
const CACHE_KEY = 'pokedex-3d-v2';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ApiForm {
  name: string;
  model: string;
  formName: string;
}

export interface ApiPokemon {
  id: number;
  forms: ApiForm[];
}

export interface Form {
  speciesId: number;
  name: string;
  formName: string;
  model: string;
  shiny: boolean;
  /** False when the model file doesn't exist in the assets repo. */
  available: boolean;
}

export interface Species {
  id: number;
  /** Display name without API-specific suffixes ("Unfezant", not "Unfezant-Female"). */
  name: string;
  /** Squashed lowercase name used for OCR matching ("mrmime", "tapukoko"). */
  key: string;
  forms: Form[];
  /** The form shown when the card has no form keyword. */
  defaultForm: Form;
}

/** Species whose API default form isn't the one printed on most cards. */
const DEFAULT_FORM_OVERRIDES: Record<number, string> = {
  718: 'Zygarde (50% form)',
};

/** Lowercase, strip accents and punctuation, keep letters and digits only. */
export function squash(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Split into squashed words ("G-Max" stays one word: "gmax"). */
export function words(text: string): string[] {
  return text
    .split(/[\s()]+/)
    .map(squash)
    .filter(Boolean);
}

function cleanSpeciesName(name: string): string {
  return name
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/-Female$/i, '')
    .replace(/\s+(Confined|Cell)$/i, '')
    .trim();
}

function isShinyForm(form: ApiForm): boolean {
  return /shiny/i.test(form.formName) || /\bshiny\b/i.test(form.name);
}

/** "…/assets/main/models/opt/galar/78.glb" → "models/opt/galar/78.glb" */
function assetPath(url: string): string {
  const i = url.indexOf('models/');
  return i >= 0 ? url.slice(i) : url;
}

/**
 * Resolves each form's model against the files that actually exist (`files`: repo paths).
 * Without a file list every model is assumed to exist.
 */
function resolveModels(pokemon: ApiPokemon, files: string[] | null): { model: string; available: boolean }[] {
  if (!files) return pokemon.forms.map((f) => ({ model: f.model, available: true }));
  // The repo's folder casing differs from the API's in places (multiShinyForm vs multishinyform).
  const byLowerPath = new Map(files.map((f) => [f.toLowerCase(), f]));
  const seen = new Map<string, number>();
  return pokemon.forms.map((f) => {
    let path = assetPath(f.model);
    // Forms sharing one URL (Paldean Tauros breeds) are stored as 128-1.glb, 128-2.glb, …
    const shared = pokemon.forms.filter((g) => g.model === f.model).length > 1;
    if (shared) {
      const index = (seen.get(path) ?? 0) + 1;
      seen.set(path, index);
      path = path.replace(/(\d+)\.glb$/, `$1-${index}.glb`);
    }
    const actual = byLowerPath.get(path.toLowerCase());
    return actual ? { model: ASSETS_BASE_URL + actual, available: true } : { model: f.model, available: false };
  });
}

export function buildCatalog(data: ApiPokemon[], files: string[] | null = null): Species[] {
  return data
    .filter((p) => p.forms.length > 0)
    .map((p) => {
      const models = resolveModels(p, files);
      const forms: Form[] = p.forms.map((f, i) => ({
        speciesId: p.id,
        name: f.name,
        formName: f.formName,
        shiny: isShinyForm(f),
        ...models[i],
      }));
      const base = forms.find((f) => !f.shiny) ?? forms[0];
      const name = cleanSpeciesName(base.name);
      const override = DEFAULT_FORM_OVERRIDES[p.id];
      const defaultForm = (override && forms.find((f) => f.name === override)) || base;
      return { id: p.id, name, key: squash(name), forms, defaultForm };
    });
}

/** The shiny counterpart of a form, if the API has one. */
export function shinyOf(species: Species, form: Form): Form | undefined {
  if (form.shiny) return form;
  const target = words(form.name).join(' ');
  const exact = species.forms.find(
    (f) => f.shiny && words(f.name).filter((w) => w !== 'shiny').join(' ') === target,
  );
  if (exact) return exact;
  if (form === species.forms.find((f) => !f.shiny)) {
    return species.forms.find((f) => f.formName === 'shiny');
  }
  return undefined;
}

export function regularOf(species: Species, form: Form): Form {
  if (!form.shiny) return form;
  return species.forms.find((f) => !f.shiny && shinyOf(species, f) === form) ?? species.defaultForm;
}

interface CachedCatalog {
  data: ApiPokemon[];
  files: string[] | null;
}

function readCache(): CachedCatalog | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { savedAt, data, files } = JSON.parse(raw);
    return Date.now() - savedAt < CACHE_TTL_MS && files ? { data, files } : null;
  } catch {
    return null;
  }
}

function writeCache({ data, files }: CachedCatalog) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data, files }));
  } catch {
    // Storage full or blocked; the catalog just won't be cached.
  }
}

/** Model file paths in the assets repo, or null if GitHub can't be reached (e.g. rate-limited). */
async function fetchModelFiles(): Promise<string[] | null> {
  try {
    const res = await fetch(ASSETS_TREE_URL, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const { tree } = (await res.json()) as { tree: { path: string; type: string }[] };
    return tree.filter((t) => t.type === 'blob' && t.path.endsWith('.glb')).map((t) => t.path);
  } catch {
    return null;
  }
}

let catalogPromise: Promise<Species[]> | null = null;

/** Fetches the catalog once. The free API host can take ~30-60s to wake up. */
export function loadCatalog(): Promise<Species[]> {
  catalogPromise ??= (async () => {
    const cached = readCache();
    if (cached) return buildCatalog(cached.data, cached.files);
    const [data, files] = await Promise.all([
      fetch(API_URL, { signal: AbortSignal.timeout(90_000) }).then((res) => {
        if (!res.ok) throw new Error(`Pokémon 3D API responded ${res.status}`);
        return res.json() as Promise<ApiPokemon[]>;
      }),
      fetchModelFiles(),
    ]);
    writeCache({ data, files });
    return buildCatalog(data, files);
  })().catch((err) => {
    catalogPromise = null;
    throw err;
  });
  return catalogPromise;
}
