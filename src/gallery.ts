// Full-screen card viewer: one card enlarged, with every printed version of the Pokémon below.

import { type CardVariant, cardImage } from './tcgdex';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SWIPE_DISTANCE = 40;
// TCGdex serves images from one server that slows down badly under many parallel requests
// (30 at once take ~6 s), so thumbnails download a few at a time.
const MAX_PARALLEL_THUMBNAILS = 6;

/** Downloads queued images a few at a time, in the order they were queued. */
class ImageQueue {
  private waiting: HTMLImageElement[] = [];
  private active = 0;

  add(img: HTMLImageElement) {
    this.waiting.push(img);
    this.pump();
  }

  clear() {
    this.waiting = [];
  }

  private pump() {
    while (this.active < MAX_PARALLEL_THUMBNAILS && this.waiting.length > 0) {
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
  private cards: CardVariant[] = [];
  private index = -1;
  private openToken = 0;
  private thumbnails = new ImageQueue();
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
    this.dialog.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') this.step(-1);
      if (e.key === 'ArrowRight') this.step(1);
    });
    this.prev.addEventListener('click', () => this.step(-1));
    this.next.addEventListener('click', () => this.step(1));

    // Swipe the big card sideways on touch screens.
    const main = this.image.parentElement!;
    let start: { x: number; y: number } | null = null;
    main.addEventListener('pointerdown', (e) => (start = { x: e.clientX, y: e.clientY }));
    main.addEventListener('pointerup', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      start = null;
      if (Math.abs(dx) > SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy)) this.step(dx < 0 ? 1 : -1);
    });
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
        img.dataset.src = cardImage(card.image, 'low');
        img.alt = '';
        img.decoding = 'async';
        const fallback = document.createElement('span');
        fallback.textContent = card.name;
        const button = document.createElement('button');
        button.type = 'button';
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

  /** Shows the small image at once (usually cached), then swaps in the sharp one. */
  private showImage(card: CardVariant | null) {
    this.caption.replaceChildren();
    if (!card) {
      this.image.removeAttribute('src');
      this.image.alt = '';
      return;
    }
    // Dim the previous card until the new one arrives, so the picture never mismatches the caption.
    const isCurrent = () => this.cards[this.index] === card;
    this.image.classList.add('loading');
    this.image.alt = card.name;
    const small = new Image();
    small.fetchPriority = 'high';
    small.onload = () => {
      if (!isCurrent() || this.image.src === sharp.src) return;
      this.image.src = small.src;
      this.image.classList.remove('loading');
    };
    const sharp = new Image();
    sharp.fetchPriority = 'high';
    sharp.onload = () => {
      if (!isCurrent()) return;
      this.image.src = sharp.src;
      this.image.classList.remove('loading');
    };
    small.src = cardImage(card.image, 'low');
    sharp.src = cardImage(card.image, 'high');

    const name = document.createElement('strong');
    name.textContent = card.name;
    const details = [card.setName, `#${card.number}`].filter(Boolean).join(' · ');
    this.caption.append(name, details);
  }
}
