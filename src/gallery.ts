// Full-screen card viewer: one card enlarged, with every printed version of the Pokémon below.

import { foilFor, HoloCard } from './holo';
import { type CardVariant, cardDetails, hiresImage } from './cards';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
// TCGdex serves images from one server that slows down badly under many parallel requests
// (30 at once take ~6 s), so thumbnails download a few at a time.
const MAX_PARALLEL_THUMBNAILS = 6;
// A press that moves further than this is a tilt, not a tap.
const TAP_SLOP_PX = 8;

/** Downloads queued images a few at a time, in the order they were queued. */
class ImageQueue {
  private waiting: HTMLImageElement[] = [];
  private active = 0;
  private paused = false;

  /** Holds new downloads back, e.g. while the big card loads from the same slow server. */
  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.pump();
  }

  add(img: HTMLImageElement) {
    this.waiting.push(img);
    this.pump();
  }

  clear() {
    this.waiting = [];
  }

  private pump() {
    while (!this.paused && this.active < MAX_PARALLEL_THUMBNAILS && this.waiting.length > 0) {
      const img = this.waiting.shift()!;
      this.active++;
      const done = () => {
        this.active--;
        this.pump();
      };
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
      img.src = img.dataset.src!;
    }
  }
}

export class CardGallery {
  private dialog = $<HTMLDialogElement>('gallery');
  private title = $('gallery-title');
  private count = $('gallery-count');
  private image = $<HTMLImageElement>('gallery-image');
  private caption = $('gallery-caption');
  private grid = $('gallery-grid');
  private status = $('gallery-status');
  private prev = $<HTMLButtonElement>('gallery-prev');
  private next = $<HTMLButtonElement>('gallery-next');
  private focusButton = $<HTMLButtonElement>('gallery-focus');
  private cards: CardVariant[] = [];
  private index = -1;
  private openToken = 0;
  private thumbnails = new ImageQueue();
  private holo = new HoloCard($('gallery-card'));
  // Only thumbnails on screen (or about to be) are downloaded.
  private visibility = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this.visibility.unobserve(entry.target);
        this.thumbnails.add(entry.target as HTMLImageElement);
      }
    },
    { root: document.querySelector('.gallery-list'), rootMargin: '200px 0px' },
  );

  constructor() {
    $('gallery-close').addEventListener('click', () => this.dialog.close());
    // A click on the dialog element itself is a click on the backdrop around it.
    this.dialog.addEventListener('click', (e) => e.target === this.dialog && this.dialog.close());
    // Listen on the document: in focus mode the focused element (the close button) is hidden,
    // so key presses no longer arrive through the dialog.
    document.addEventListener('keydown', (e) => {
      if (!this.dialog.open) return;
      if (e.key === 'ArrowLeft') this.step(-1);
      if (e.key === 'ArrowRight') this.step(1);
    });
    this.prev.addEventListener('click', () => this.step(-1));
    this.next.addEventListener('click', () => this.step(1));
    this.dialog.addEventListener('close', () => {
      this.holo.stop();
      this.setFocused(false);
    });
    this.setupFocus();
  }

  /**
   * Focus mode: the card alone, as large as the screen allows. Toggled by tapping the card
   * (a drag only tilts it) or the corner button; Esc or tapping around the card leaves it.
   */
  private setupFocus() {
    const card = $('gallery-card');
    let down: { x: number; y: number } | null = null;
    card.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    card.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved <= TAP_SLOP_PX) this.setFocused(!this.focused);
    });
    this.focusButton.addEventListener('click', () => this.setFocused(!this.focused));
    // Tapping the empty space around the focused card leaves focus.
    card.parentElement!.addEventListener('click', (e) => {
      if (this.focused && e.target === e.currentTarget) this.setFocused(false);
    });
    // Esc leaves focus first instead of closing the whole gallery.
    this.dialog.addEventListener('cancel', (e) => {
      if (!this.focused) return;
      e.preventDefault();
      this.setFocused(false);
    });
  }

  private get focused(): boolean {
    return this.dialog.classList.contains('focused');
  }

  private setFocused(on: boolean) {
    this.dialog.classList.toggle('focused', on);
    this.focusButton.setAttribute('aria-pressed', String(on));
    this.focusButton.setAttribute('aria-label', on ? 'Exit focus' : 'Focus card');
  }

  /**
   * Opens the viewer on `selectedId` (or the first card). `current` is the scanned card,
   * shown straight away while the full list loads.
   */
  async open(pokemon: string, cards: Promise<CardVariant[]>, selectedId?: string, current?: CardVariant) {
    const token = ++this.openToken;
    this.title.textContent = `${pokemon} cards`;
    this.count.textContent = '';
    this.visibility.disconnect();
    this.thumbnails.clear();
    this.grid.replaceChildren();
    this.cards = current ? [current] : [];
    this.index = -1;
    if (current) this.select(0);
    else this.showImage(null);
    this.setStatus('Loading cards…');
    if (!this.dialog.open) this.dialog.showModal();
    this.holo.start();

    try {
      const list = await cards;
      if (token !== this.openToken) return;
      this.cards = current && !list.some((c) => c.id === current.id) ? [current, ...list] : list;
      this.count.textContent = `${this.cards.length} ${this.cards.length === 1 ? 'card' : 'cards'}`;
      this.setStatus(this.cards.length === 0 ? 'No cards found for this Pokémon.' : null);
      this.renderGrid();
      const selected = this.cards.findIndex((c) => c.id === selectedId);
      this.select(Math.max(0, selected));
    } catch (err) {
      console.warn('Loading card variants failed', err);
      if (token === this.openToken) this.setStatus("Couldn't load the other cards. Check your connection.");
    }
  }

  private setStatus(message: string | null) {
    this.status.hidden = !message;
    this.status.textContent = message ?? '';
  }

  private renderGrid() {
    this.grid.replaceChildren(
      ...this.cards.map((card, i) => {
        const img = document.createElement('img');
        img.addEventListener('load', () => button.classList.add('loaded'));
        img.addEventListener('error', () => button.classList.add('failed'));
        img.dataset.src = card.images.small;
        img.alt = '';
        img.decoding = 'async';
        const fallback = document.createElement('span');
        fallback.textContent = card.name;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.cardId = card.id;
        button.title = [card.name, card.setName].filter(Boolean).join(' · ');
        button.setAttribute('aria-label', button.title);
        button.append(img, fallback);
        this.visibility.observe(img);
        button.addEventListener('click', () => this.select(i));
        const li = document.createElement('li');
        li.append(button);
        return li;
      }),
    );
  }

  private step(delta: number) {
    if (this.cards.length > 1) this.select(Math.min(this.cards.length - 1, Math.max(0, this.index + delta)));
  }

  private select(index: number) {
    const card = this.cards[index];
    if (!card) return;
    this.index = index;
    this.showImage(card);
    this.prev.disabled = index === 0;
    this.next.disabled = index === this.cards.length - 1;
    this.grid.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-current', String(i === index)));
    this.grid.children[index]?.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Shows the small image at once (usually cached), then sharper ones as they arrive:
   * the 600–734px image, then the 734px pokemontcg.io scan if there is a sharper one. Never waits
   * on a slower source before showing a faster one. The foil follows once the rarity is known.
   */
  private showImage(card: CardVariant | null) {
    this.caption.replaceChildren();
    if (!card) {
      this.image.removeAttribute('src');
      this.image.alt = '';
      this.image.parentElement!.classList.remove('has-image');
      return;
    }
    // Dim the previous card until the new one arrives, so the picture never mismatches the caption.
    const isCurrent = () => this.cards[this.index] === card;
    this.image.classList.add('loading');
    this.image.alt = card.name;
    this.holo.setFoil('none', card.series);

    // Thumbnails share TCGdex's slow server, so they wait until this card has a picture.
    this.thumbnails.pause();
    const resumeThumbnails = setTimeout(() => this.thumbnails.resume(), 4000);
    let shownQuality = -1;
    const load = (url: string, quality: number) => {
      const img = new Image();
      img.fetchPriority = 'high';
      img.onload = () => {
        if (!isCurrent() || quality <= shownQuality) return;
        shownQuality = quality;
        this.image.src = url;
        this.image.classList.remove('loading');
        this.image.parentElement!.classList.add('has-image');
        clearTimeout(resumeThumbnails);
        this.thumbnails.resume();
      };
      img.src = url;
    };
    load(card.images.small, 0);
    load(card.images.large, 1);
    hiresImage(card).then((url) => url && isCurrent() && load(url, 2));

    cardDetails(card)
      .then(({ rarity, holo }) => isCurrent() && this.holo.setFoil(foilFor(rarity, holo), card.series))
      .catch(() => {});

    const name = document.createElement('strong');
    name.textContent = card.name;
    const details = [card.setName, `#${card.number}`].filter(Boolean).join(' · ');
    this.caption.append(name, details);
  }
}
