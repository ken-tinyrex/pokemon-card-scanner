import { blockedByInsecurePage, CardCamera, cameraSupported, type Facing } from './camera';
import type { Detection } from './match';
import { type Form, loadCatalog, regularOf, shinyOf, type Species, squash } from './pokedex';
import { buildSearchEntries, type SearchEntry, suggest } from './search';
import { readCard, toCanvas, warmUpOcr } from './recognize';
import { type AnimationState, PokemonStage } from './stage';
import { CardGallery } from './gallery';
import { type CardInfo, type CardVariant, cardImage, cardsForSpecies, findCard, TYPE_COLORS } from './tcgdex';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  stage: $('stage'),
  emptyHint: $('empty-hint'),
  info: $('info'),
  thumb: $<HTMLImageElement>('card-thumb'),
  thumbButton: $<HTMLButtonElement>('card-thumb-button'),
  allCards: $<HTMLButtonElement>('all-cards'),
  dex: $('dex'),
  name: $('name'),
  formName: $('form-name'),
  types: $('types'),
  cardSet: $('card-set'),
  shiny: $<HTMLButtonElement>('shiny'),
  progress: $('progress'),
  status: $('status'),
  scan: $<HTMLButtonElement>('scan'),
  upload: $<HTMLButtonElement>('upload'),
  file: $<HTMLInputElement>('file'),
  search: $<HTMLFormElement>('search'),
  searchInput: $<HTMLInputElement>('search-input'),
  suggestions: $('search-suggestions'),
  camera: $('camera'),
  cameraVideo: $<HTMLVideoElement>('camera-video'),
  cameraGuide: $('camera-guide'),
  cameraStatus: $('camera-status'),
  cameraCancel: $<HTMLButtonElement>('camera-cancel'),
  cameraSwitch: $<HTMLButtonElement>('camera-switch'),
  cameraSwitchLabel: $('camera-switch-label'),
  anims: $('anims'),
  animAll: $<HTMLButtonElement>('anim-all'),
  animList: $('anim-list'),
};

let stage: PokemonStage;
let current: { species: Species; form: Form } | null = null;
let busy = false;
const camera = new CardCamera(ui.cameraVideo, ui.cameraGuide);

function setStatus(message: string, isError = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle('error', isError);
}

/** fraction: 0..1 for a determinate bar, null for indeterminate, undefined to hide. */
function setProgress(fraction?: number | null) {
  ui.progress.hidden = fraction === undefined;
  ui.progress.classList.toggle('indeterminate', fraction === null);
  if (typeof fraction === 'number') ui.progress.style.setProperty('--progress', `${Math.round(fraction * 100)}%`);
}

function setBusy(value: boolean) {
  busy = value;
  ui.scan.disabled = value;
  ui.upload.disabled = value;
}

/** Loads the catalog, telling the user if the API host is still waking up. */
async function getCatalog(): Promise<Species[]> {
  const slow = setTimeout(() => setStatus('Waking up the Pokédex server… (first load can take up to a minute)'), 2500);
  try {
    return await loadCatalog();
  } finally {
    clearTimeout(slow);
  }
}

// ---------- Showing a Pokémon ----------

function renderInfo(species: Species, form: Form) {
  ui.info.hidden = false;
  ui.emptyHint.hidden = true;
  ui.dex.textContent = `#${String(species.id).padStart(4, '0')}`;
  ui.name.textContent = species.name;
  ui.formName.textContent = form.name !== species.name ? form.name : '';
  const shinyForm = shinyOf(species, regularOf(species, form));
  ui.shiny.hidden = !shinyForm?.available || !regularOf(species, form).available;
  ui.shiny.setAttribute('aria-pressed', String(form.shiny));
}

// ---------- Card details and gallery ----------

const gallery = new CardGallery();
/** The printed card matched on TCGdex, and every print of the current Pokémon. */
let currentCard: CardInfo | null = null;
let variants: Promise<CardVariant[]> | null = null;

function resetCardDetails() {
  currentCard = null;
  variants = null;
  ui.thumbButton.hidden = true;
  ui.allCards.hidden = true;
  ui.types.replaceChildren();
  ui.cardSet.textContent = '';
  stage.setAccent(null);
}

const CONTROLS_HINT = matchMedia('(pointer: coarse)').matches
  ? 'Drag to rotate, pinch to zoom'
  : 'Drag to rotate, scroll to zoom';

/** The model to display: the form itself, or the species' default when that form has no model yet. */
function modelFor(species: Species, form: Form): Form | null {
  if (form.available) return form;
  const fallback = regularOf(species, form).available ? regularOf(species, form) : species.defaultForm;
  return fallback.available ? fallback : null;
}

async function showForm(species: Species, form: Form) {
  current = { species, form };
  renderInfo(species, form);
  const model = modelFor(species, form);
  if (!model) {
    setProgress();
    setStatus(`Found ${form.name}, but it doesn't have a 3D model yet.`, true);
    return;
  }
  const note = model !== form ? `No 3D model for ${form.name} yet, showing ${model.name}. ` : '';
  ui.anims.hidden = true;
  setProgress(0);
  setStatus(`${note}Summoning ${model.name}…`);
  try {
    await stage.show(model.model, { species: species.name, onProgress: (f) => setProgress(f) });
    if (current?.form === form) setStatus(`${note}${CONTROLS_HINT}`);
  } catch (err) {
    console.error(err);
    if (current?.form === form) setStatus(`Couldn't load the 3D model for ${model.name}.`, true);
  } finally {
    if (current?.form === form) setProgress();
  }
}

/** Fills in type, set and card art from TCGdex. Non-blocking and optional. */
async function enrichFromTcgdex(detection: Detection) {
  loadVariants(detection.species);
  try {
    const card = await findCard(detection);
    if (!card || current?.species !== detection.species) return;
    currentCard = card;
    if (card.image) {
      ui.thumb.src = cardImage(card.image, 'low');
      ui.thumb.alt = card.name;
      ui.thumbButton.hidden = false;
    }
    ui.types.replaceChildren(
      ...card.types.map((type) => {
        const li = document.createElement('li');
        li.textContent = type;
        li.style.setProperty('--type-color', `#${(TYPE_COLORS[type] ?? 0xcccccc).toString(16).padStart(6, '0')}`);
        return li;
      }),
    );
    const cardName = card.name !== detection.species.name ? card.name : null;
    ui.cardSet.textContent = [cardName, card.set].filter(Boolean).join(' · ');
    stage.setAccent(TYPE_COLORS[card.types[0]] ?? null);
  } catch (err) {
    console.warn('TCGdex lookup failed', err);
  }
}

/** Fetches every print of the Pokémon in the background, for the "All cards" link. */
function loadVariants(species: Species) {
  const list = cardsForSpecies(species.id);
  variants = list;
  list
    .then((cards) => {
      if (variants !== list || cards.length === 0) return;
      ui.allCards.textContent = `See all ${cards.length} ${species.name} cards`;
      ui.allCards.hidden = false;
    })
    .catch((err) => console.warn('Loading card variants failed', err));
}

function openGallery() {
  if (!current || !variants) return;
  const card = currentCard;
  const scanned = card?.image ? { id: card.id, name: card.name, number: card.number, image: card.image, setName: card.set } : undefined;
  gallery.open(current.species.name, variants, card?.id, scanned);
}

async function onDetected(detection: Detection) {
  resetCardDetails();
  enrichFromTcgdex(detection);
  await showForm(detection.species, detection.form);
}

// ---------- Animations ----------

function animationChip(label: string, index: number | null, active: boolean): HTMLButtonElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.textContent = label;
  chip.setAttribute('aria-pressed', String(active));
  chip.addEventListener('click', () => stage.playAnimation(index));
  return chip;
}

/** Shows a button per animation clip, with the playing one highlighted. */
function renderAnimations({ labels, idleIndex, active, playingAll }: AnimationState) {
  const clips = labels.map((label, index) => ({ label, index })).filter(({ index }) => index !== idleIndex);
  ui.anims.hidden = clips.length === 0;
  if (clips.length === 0) return;

  const idleActive = active === null || active === idleIndex;
  ui.animList.replaceChildren(
    animationChip('Idle', null, idleActive && !playingAll),
    ...clips.map(({ label, index }) => animationChip(label, index, index === active)),
  );
  ui.animAll.textContent = playingAll ? 'Stop' : 'Play all';
  ui.animAll.setAttribute('aria-pressed', String(playingAll));
  ui.animList.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---------- Upload ----------

async function loadImage(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const canvas = toCanvas(bitmap, bitmap.width, bitmap.height);
  bitmap.close();
  return canvas;
}

async function scanFile(file: File) {
  setBusy(true);
  setProgress(null);
  try {
    setStatus('Reading the card…');
    const [catalog, card] = await Promise.all([getCatalog(), loadImage(file)]);
    setStatus('Reading the card name…');
    const detection = await readCard(card, catalog);
    if (!detection) {
      setProgress();
      setStatus("Couldn't read a Pokémon name. Try a sharper, well-lit photo, or type the name below.", true);
      return;
    }
    await onDetected(detection);
  } catch (err) {
    console.error(err);
    setProgress();
    setStatus(err instanceof Error ? err.message : 'Something went wrong while scanning.', true);
  } finally {
    setBusy(false);
  }
}

// ---------- Live camera ----------

let scanLoopId = 0;
const FACING_KEY = 'camera-facing';

/** The camera that last worked on this device (back camera by default). */
function preferredFacing(): Facing {
  try {
    return localStorage.getItem(FACING_KEY) === 'user' ? 'user' : 'environment';
  } catch {
    return 'environment';
  }
}

function rememberFacing(facing: Facing) {
  try {
    localStorage.setItem(FACING_KEY, facing);
  } catch {
    // Not persisted; the back camera is tried first next time.
  }
}

const cameraName = (facing: Facing) => (facing === 'user' ? 'front' : 'back');

/** Starts the requested camera (falling back to another), then offers switching if there are two. */
async function startCamera(requested: Facing) {
  const gotPreferred = await camera.start(requested);
  rememberFacing(camera.facing);
  ui.cameraSwitch.hidden = (await camera.cameraCount()) < 2;
  ui.cameraSwitchLabel.textContent = camera.facing === 'user' ? 'Back camera' : 'Front camera';
  if (!gotPreferred) {
    ui.cameraStatus.textContent = `The ${cameraName(requested)} camera didn't start, so the ${cameraName(camera.facing)} camera is in use.`;
  }
  runScanLoop(++scanLoopId, gotPreferred ? 0 : 3000);
}

async function openCamera() {
  if (blockedByInsecurePage()) {
    const secureUrl = location.href.replace(/^http:/, 'https:');
    setStatus(`Live scanning needs a secure page. Open ${secureUrl} instead, or use Upload to take a photo.`, true);
    return;
  }
  if (!cameraSupported()) {
    // Very old browsers without live camera access: offer the camera through the photo picker.
    ui.file.setAttribute('capture', 'environment');
    ui.file.click();
    return;
  }
  ui.camera.hidden = false;
  ui.cameraSwitch.hidden = true;
  ui.cameraStatus.textContent = 'Starting camera…';
  warmUpOcr().catch(() => {});
  try {
    await startCamera(preferredFacing());
  } catch (err) {
    console.error(err);
    closeCamera();
    const denied = err instanceof DOMException && err.name === 'NotAllowedError';
    setStatus(denied ? 'Camera permission was denied. Allow it in your browser settings, or use Upload.' : 'No working camera found. Use Upload instead.', true);
  }
}

async function switchCamera() {
  scanLoopId++; // Pause scanning while the camera changes.
  ui.cameraSwitch.disabled = true;
  ui.cameraStatus.textContent = 'Switching camera…';
  try {
    await startCamera(camera.facing === 'user' ? 'environment' : 'user');
  } catch (err) {
    console.error(err);
    closeCamera();
    setStatus('No working camera found. Use Upload instead.', true);
  } finally {
    ui.cameraSwitch.disabled = false;
  }
}

function closeCamera() {
  scanLoopId++;
  camera.stop();
  ui.camera.hidden = true;
}

/**
 * Reads frames until two of the last three agree on a Pokémon (or one reads it exactly).
 * `noticeMs` keeps a camera-fallback notice on screen for a moment before scanning hints replace it.
 */
async function runScanLoop(id: number, noticeMs = 0) {
  const startedAt = Date.now();
  const recent: (string | null)[] = [];
  try {
    if (!noticeMs) ui.cameraStatus.textContent = 'Loading scanner…';
    const catalog = await getCatalog();
    await warmUpOcr();
    let attempts = 0;
    while (id === scanLoopId) {
      const elapsed = Date.now() - startedAt;
      if (elapsed < noticeMs) {
        // Keep showing the fallback notice.
      } else if (!camera.hasVideo && elapsed > 4000) {
        ui.cameraStatus.textContent = ui.cameraSwitch.hidden
          ? "The camera isn't sending any picture. Try closing other apps using it."
          : "This camera isn't sending any picture. Try switching cameras.";
      } else {
        ui.cameraStatus.textContent =
          elapsed > 12_000 ? 'Tip: fill the frame, keep the name in the yellow band, avoid glare' : 'Hold the card inside the frame';
      }
      const frame = camera.hasVideo ? camera.captureCard() : null;
      const detection = frame ? await readCard(frame, catalog, { quick: true, attempt: attempts++ }) : null;
      if (id !== scanLoopId) return;
      const key = detection?.form.name ?? null;
      recent.push(key);
      if (recent.length > 3) recent.shift();
      if (detection) {
        const confident = detection.distance === 0 && detection.species.key.length >= 5;
        if (confident || recent.filter((k) => k === key).length >= 2) {
          closeCamera();
          await onDetected(detection);
          return;
        }
        ui.cameraStatus.textContent = `Found ${detection.species.name}? Hold still…`;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  } catch (err) {
    console.error(err);
    if (id === scanLoopId) {
      closeCamera();
      setStatus(err instanceof Error ? err.message : 'Scanner failed to start.', true);
    }
  }
}

// ---------- Manual search ----------

let searchEntries: SearchEntry[] | null = null;
let suggestions: SearchEntry[] = [];
let highlighted = -1;

async function loadSearchEntries(): Promise<SearchEntry[]> {
  searchEntries ??= buildSearchEntries(await getCatalog());
  return searchEntries;
}

function suggestionRow(content: string | (string | Node)[], className = ''): HTMLLIElement {
  const li = document.createElement('li');
  li.className = className;
  li.append(...(typeof content === 'string' ? [content] : content));
  return li;
}

function closeSuggestions() {
  suggestions = [];
  highlighted = -1;
  ui.suggestions.hidden = true;
  ui.searchInput.setAttribute('aria-expanded', 'false');
  ui.searchInput.removeAttribute('aria-activedescendant');
}

function renderSuggestions() {
  const text = ui.searchInput.value.trim();
  if (!text || document.activeElement !== ui.searchInput) return closeSuggestions();
  ui.suggestions.hidden = false;
  ui.searchInput.setAttribute('aria-expanded', 'true');

  if (!searchEntries) {
    // The Pokédex can take a while on first load (the API host sleeps when idle).
    ui.suggestions.replaceChildren(suggestionRow('Loading the Pokédex…', 'info'));
    loadSearchEntries()
      .then(renderSuggestions)
      .catch(() => ui.suggestions.replaceChildren(suggestionRow("Couldn't load the Pokédex. Check your connection.", 'info')));
    return;
  }

  suggestions = suggest(searchEntries, text);
  highlighted = Math.min(highlighted, suggestions.length - 1);
  if (suggestions.length === 0) {
    ui.suggestions.replaceChildren(suggestionRow('No matching Pokémon', 'info'));
    return;
  }
  ui.suggestions.replaceChildren(
    ...suggestions.map((entry, i) => {
      const dex = document.createElement('span');
      dex.className = 'suggestion-dex';
      dex.textContent = `#${String(entry.species.id).padStart(4, '0')}`;
      const li = suggestionRow([entry.label, dex]);
      li.id = `suggestion-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === highlighted));
      // Keep focus in the input while tapping (so the list doesn't close first).
      li.addEventListener('mousedown', (e) => e.preventDefault());
      li.addEventListener('click', () => choose(entry));
      return li;
    }),
  );
  if (highlighted >= 0) {
    ui.searchInput.setAttribute('aria-activedescendant', `suggestion-${highlighted}`);
    document.getElementById(`suggestion-${highlighted}`)?.scrollIntoView({ block: 'nearest' });
  } else {
    ui.searchInput.removeAttribute('aria-activedescendant');
  }
}

function onSearchKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (suggestions.length === 0) return;
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    highlighted = (highlighted + step + suggestions.length) % suggestions.length;
    renderSuggestions();
  } else if (e.key === 'Escape') {
    closeSuggestions();
  }
}

function choose(entry: SearchEntry) {
  ui.searchInput.value = '';
  closeSuggestions();
  ui.searchInput.blur(); // Also dismisses the phone keyboard.
  resetCardDetails();
  enrichFromTcgdex({ species: entry.species, form: entry.form, title: entry.label, context: '', distance: 0, score: 0 });
  showForm(entry.species, entry.form);
}

/** Enter / the keyboard's Search key: the highlighted suggestion, else the best match. */
async function onSearch(event: SubmitEvent) {
  event.preventDefault();
  const text = ui.searchInput.value.trim();
  if (!text) return;
  let pick: SearchEntry | undefined = suggestions[highlighted];
  if (!pick) {
    const waiting = !searchEntries;
    if (waiting) {
      setStatus('Loading the Pokédex…');
      setProgress(null);
    }
    try {
      const entries = await loadSearchEntries();
      pick = entries.find((e) => e.key === squash(text)) ?? suggest(entries, text, 1)[0];
    } catch (err) {
      console.error(err);
      setProgress();
      setStatus("Couldn't reach the Pokémon 3D API. Check your connection and try again.", true);
      return;
    } finally {
      if (waiting) setProgress();
    }
  }
  if (!pick) {
    setStatus(`No Pokémon called "${text}".`, true);
    return;
  }
  choose(pick);
}

// ---------- Layout ----------

/** Tells the stage which screen areas the UI covers so the Pokémon stands in the gap. */
function updateStageInsets() {
  const dockTop = document.querySelector('.dock')!.getBoundingClientRect().top;
  const header = document.querySelector('.topbar')!.getBoundingClientRect().bottom;
  const infoBox = ui.info.getBoundingClientRect();
  // The info panel only blocks the middle of the screen when it spans the width (phones).
  const infoBlocks = !ui.info.hidden && infoBox.width > window.innerWidth * 0.6;
  const top = infoBlocks ? infoBox.bottom + 8 : header + 8;
  stage.setInsets(top, window.innerHeight - dockTop + 16);
}

// ---------- Boot ----------

async function main() {
  stage = await PokemonStage.create(ui.stage);
  stage.onAnimationChange = renderAnimations;
  ui.animAll.addEventListener('click', () => stage.playAllAnimations(ui.animAll.getAttribute('aria-pressed') !== 'true'));
  const layoutObserver = new ResizeObserver(updateStageInsets);
  layoutObserver.observe(document.querySelector('.dock')!);
  layoutObserver.observe(ui.info);
  layoutObserver.observe(ui.stage);

  ui.scan.addEventListener('click', () => !busy && openCamera());
  ui.upload.addEventListener('click', () => {
    ui.file.removeAttribute('capture');
    ui.file.click();
  });
  ui.file.addEventListener('change', () => {
    const file = ui.file.files?.[0];
    ui.file.value = '';
    if (file) scanFile(file);
  });
  ui.thumb.addEventListener('error', () => (ui.thumbButton.hidden = true));
  ui.thumbButton.addEventListener('click', openGallery);
  ui.allCards.addEventListener('click', openGallery);
  ui.cameraCancel.addEventListener('click', closeCamera);
  ui.cameraSwitch.addEventListener('click', switchCamera);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && camera.active && closeCamera());
  ui.search.addEventListener('submit', onSearch);
  ui.searchInput.addEventListener('input', () => {
    highlighted = -1;
    renderSuggestions();
  });
  ui.searchInput.addEventListener('focus', renderSuggestions);
  ui.searchInput.addEventListener('keydown', onSearchKeydown);
  // Delay so a tap on a suggestion registers before the list closes.
  ui.searchInput.addEventListener('blur', () => setTimeout(closeSuggestions, 200));
  ui.shiny.addEventListener('click', () => {
    if (!current) return;
    const { species, form } = current;
    const next = form.shiny ? regularOf(species, form) : shinyOf(species, form);
    if (next && next !== form) showForm(species, next);
  });

  // Start the slow API wake-up early so it's ready by the first scan.
  loadCatalog()
    .then((catalog) => (searchEntries = buildSearchEntries(catalog)))
    .catch((err) => console.warn('Catalog preload failed', err));
}

main().catch((err) => {
  console.error(err);
  setStatus('This browser could not start the 3D scene (WebGL required).', true);
});
