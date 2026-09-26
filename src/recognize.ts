// Reads the name printed at the top of a Pokémon card with Tesseract OCR.

import { createWorker, PSM, type Page, type Worker } from 'tesseract.js';
import { type Detection, detectFromLines, mergeDetections, type OcrLine, stripEvolvesFrom } from './match';
import type { Species } from './pokedex';

let workerPromise: Promise<Worker> | null = null;

/** Starts downloading the OCR engine and English model (~a few MB) ahead of the first scan. */
export function warmUpOcr(): Promise<Worker> {
  workerPromise ??= createWorker('eng').catch((err) => {
    workerPromise = null;
    throw err;
  });
  return workerPromise;
}

/** One OCR attempt: which part of the card to read, at what size, in which Tesseract mode. */
interface Pass {
  /** Fraction of the card height to read, from the top. */
  band: number;
  /** Width the crop is scaled to before OCR. */
  width: number;
  psm: PSM;
  /** Grayscale with extra contrast; helps with stylised VMAX/VSTAR titles. */
  gray?: boolean;
  /** Only accept near-exact names (used for text from the whole card). */
  strict?: boolean;
}

// Tuned on real card scans: no single setting reads every card design, but these
// complement each other. The name sits in roughly the top eighth of a card.
const TITLE_PASSES: Pass[] = [
  { band: 0.17, width: 900, psm: PSM.SPARSE_TEXT },
  { band: 0.12, width: 600, psm: PSM.SPARSE_TEXT },
  { band: 0.17, width: 600, psm: PSM.SINGLE_BLOCK },
  { band: 0.12, width: 1200, psm: PSM.SINGLE_BLOCK },
];

// For photos where the card doesn't fill the frame.
const FALLBACK_PASSES: Pass[] = [
  { band: 0.17, width: 1200, psm: PSM.SPARSE_TEXT, gray: true },
  { band: 0.35, width: 900, psm: PSM.SPARSE_TEXT },
  { band: 1, width: 1200, psm: PSM.AUTO, strict: true },
];

/** Crops the top `band` of the card and scales it to `width`. Colour is kept: it OCRs better than grayscale here. */
function crop(card: HTMLCanvasElement, band: number, width: number, gray = false): HTMLCanvasElement {
  const sourceHeight = Math.round(card.height * band);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = Math.max(1, Math.round((sourceHeight * width) / card.width));
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  if (gray) ctx.filter = 'grayscale(1) contrast(1.4)';
  ctx.drawImage(card, 0, 0, card.width, sourceHeight, 0, 0, out.width, out.height);
  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Lines with their text size: median word height, so stray symbols don't inflate it. */
export function linesOf(page: Page): OcrLine[] {
  return (page.blocks ?? []).flatMap((block) =>
    block.paragraphs.flatMap((paragraph) =>
      paragraph.lines
        .filter((line) => line.confidence > 30)
        .map((line) => ({
          text: line.text,
          height: median(line.words.filter((w) => /[a-z]{2}/i.test(w.text)).map((w) => w.bbox.y1 - w.bbox.y0)),
        })),
    ),
  );
}

async function runPass(
  worker: Worker,
  card: HTMLCanvasElement,
  pass: Pass,
  catalog: Species[],
): Promise<{ detection: Detection | null; text: string }> {
  await worker.setParameters({ tessedit_pageseg_mode: pass.psm });
  const { data } = await worker.recognize(crop(card, pass.band, pass.width, pass.gray), {}, { blocks: true });
  const lines = linesOf(data);
  if (import.meta.env.DEV) console.debug('[ocr]', JSON.stringify(pass), JSON.stringify(lines));
  const text = lines.map((l) => stripEvolvesFrom(l.text)).join(' ');
  return { detection: detectFromLines(lines, catalog, { strict: pass.strict }), text };
}

export interface ReadOptions {
  /**
   * For live camera frames: run only two passes per frame, rotating through all of them
   * as `attempt` increases, so a card one pass can't read gets tried with the others.
   */
  quick?: boolean;
  attempt?: number;
}

const CAMERA_PASSES = [...TITLE_PASSES, FALLBACK_PASSES[0]];

/**
 * Reads the card name with several OCR passes and votes on the result.
 * Stops early once two passes agree.
 */
export async function readCard(
  card: HTMLCanvasElement,
  catalog: Species[],
  { quick = false, attempt = 0 }: ReadOptions = {},
): Promise<Detection | null> {
  const worker = await warmUpOcr();
  const detections: Detection[] = [];
  const texts: string[] = [];
  const passes = quick
    ? [0, 1].map((i) => CAMERA_PASSES[(attempt * 2 + i) % CAMERA_PASSES.length])
    : TITLE_PASSES;
  for (const pass of passes) {
    const { detection, text } = await runPass(worker, card, pass, catalog);
    texts.push(text);
    if (!detection) continue;
    detections.push(detection);
    if (detections.filter((d) => d.species === detection.species).length >= 2) break;
  }
  if (detections.length > 0 || quick) return mergeDetections(detections, texts.join(' '));

  for (const pass of FALLBACK_PASSES) {
    const { detection, text } = await runPass(worker, card, pass, catalog);
    texts.push(text);
    if (detection) return mergeDetections([detection], texts.join(' '));
  }
  return null;
}

/** Draws any image source into a canvas no larger than `maxSize` on its long edge. */
export function toCanvas(
  source: CanvasImageSource,
  width: number,
  height: number,
  crop = { x: 0, y: 0, width, height },
  maxSize = 2000,
): HTMLCanvasElement {
  const scale = Math.min(1, maxSize / Math.max(crop.width, crop.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(crop.width * scale);
  canvas.height = Math.round(crop.height * scale);
  canvas.getContext('2d')!.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}
