// Interactive card preview: the card tilts toward the pointer with a moving glare, and
// holographic cards get a foil shine that matches how the real card is printed.

/**
 * - none: no foil, just the glare of a glossy card
 * - holo: rainbow foil on the artwork window only (classic "Rare Holo")
 * - full: sparkly foil across the whole card (V, VMAX, ex, full art, illustration rares)
 * - gold: gold foil (hyper / gold secret rares)
 */
export type Foil = 'none' | 'holo' | 'full' | 'gold';

const GOLD = /hyper|crown|gold|mega hyper/i;
// Rarity names from TCGdex and pokemontcg.io ("Rare Holo VMAX", "Holo Rare VMAX", "Rare Rainbow"…).
const FULL_CARD =
  /ultra|secret|double|illustration|full art|shiny|amazing|radiant|\bace\b|holo rare v|rare holo (ex|gx|v)|vmax|vstar|legend|prime|lv\.x|black white|futuristic|pikachu rare|rainbow|break|trainer gallery/i;
const HOLO = /holo/i;

/** Which foil a card has, from its rarity and whether it's printed holo. */
export function foilFor(rarity: string | undefined, holoPrint = false): Foil {
  const r = rarity ?? '';
  if (GOLD.test(r)) return 'gold';
  if (FULL_CARD.test(r)) return 'full';
  if (HOLO.test(r) || holoPrint) return 'holo';
  return 'none';
}

/** Artwork window in percent of the card, which differs between card eras. */
export interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const ART_WINDOWS: [RegExp, Box][] = [
  // Scarlet & Violet and Mega Evolution: wide art window.
  [/^(sv|me)$/, { top: 10.5, right: 6.5, bottom: 44, left: 6.5 }],
  [/^swsh$/, { top: 11, right: 8, bottom: 46.5, left: 8 }],
  [/^(sm|xy|bw)$/, { top: 11, right: 8.5, bottom: 49.5, left: 8.5 }],
  [/^(base|gym|neo|lc|ecard|ex|pop|dp|pl|hgss|col)$/, { top: 10.5, right: 9, bottom: 52, left: 9 }],
];
const DEFAULT_ART_WINDOW: Box = { top: 11, right: 8, bottom: 48, left: 8 };

/** The artwork window for a card era ("base", "swsh", "sv", …). */
export function artWindow(series: string): Box {
  return ART_WINDOWS.find(([pattern]) => pattern.test(series))?.[1] ?? DEFAULT_ART_WINDOW;
}

const MAX_TILT_DEG = 14;
const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Drives the CSS custom properties that the `.holo` styles read:
 * --mx/--my pointer position (%), --rx/--ry tilt (deg), --active (0..1).
 */
export class HoloCard {
  private interacting = false;
  private frame = 0;
  private idleStart = performance.now();

  constructor(private card: HTMLElement) {
    card.addEventListener('pointermove', (e) => this.onPointer(e));
    card.addEventListener('pointerdown', (e) => {
      // Keep tilting while a finger drags outside the card.
      try {
        card.setPointerCapture(e.pointerId);
      } catch {
        // The pointer is already gone; nothing to capture.
      }
      this.onPointer(e);
    });
    const release = () => {
      this.interacting = false;
      this.card.classList.remove('active');
      this.idleStart = performance.now();
    };
    card.addEventListener('pointerup', release);
    card.addEventListener('pointercancel', release);
    card.addEventListener('pointerleave', (e) => e.pointerType === 'mouse' && release());
  }

  setFoil(foil: Foil, series: string) {
    this.card.dataset.foil = foil;
    const art = artWindow(series);
    this.card.style.setProperty('--art', `inset(${art.top}% ${art.right}% ${art.bottom}% ${art.left}% round 1.5%)`);
  }

  private onPointer(e: PointerEvent) {
    // Mouse hover tilts; on touch screens only a press-and-drag does.
    if (e.pointerType !== 'mouse' && e.buttons === 0) return;
    const rect = this.card.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    this.interacting = true;
    this.card.classList.add('active');
    this.apply(x, y, 1);
  }

  private apply(x: number, y: number, active: number) {
    const s = this.card.style;
    s.setProperty('--mx', `${(x * 100).toFixed(2)}%`);
    s.setProperty('--my', `${(y * 100).toFixed(2)}%`);
    s.setProperty('--rx', `${((x - 0.5) * 2 * MAX_TILT_DEG).toFixed(2)}deg`);
    s.setProperty('--ry', `${((0.5 - y) * 2 * MAX_TILT_DEG).toFixed(2)}deg`);
    s.setProperty('--active', active.toFixed(2));
  }

  /** A slow sway while nobody is touching the card, so the foil catches the light by itself. */
  start() {
    cancelAnimationFrame(this.frame);
    const tick = (now: number) => {
      if (!this.interacting) {
        if (prefersReducedMotion()) {
          this.apply(0.5, 0.5, 0);
        } else {
          const t = (now - this.idleStart) / 1000;
          const ease = Math.min(1, t / 0.8); // settle in after a release
          this.apply(0.5 + 0.28 * Math.sin(t * 0.9) * ease, 0.45 + 0.16 * Math.cos(t * 0.7) * ease, 0.55 * ease);
        }
      }
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this.frame);
  }
}
