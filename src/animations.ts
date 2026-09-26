// Readable labels for the models' animation clips, and picking the idle loop.
//
// Clip names come from many game rips: "pm0646_13_00_00400_attack01",
// "Armature|Armature|pm0887_00_00_ba20_buturi01|Base Layer", "model_skeleton|001aidle",
// "kartana_idle", "ArmatureAction.001", …

// Words used in the clip names, mapped to what they show. Japanese terms come from the games:
// buturi = physical move, tokusyu = special move.
const WORDS: Record<string, string> = {
  defaultwait: 'Idle',
  battlewait: 'Battle stance',
  defaultidle: 'Fidget',
  battleidle: 'Battle fidget',
  uniquewait: 'Special idle',
  waita: 'Idle',
  wait: 'Idle',
  aidle: 'Idle',
  idle: 'Idle',
  idol: 'Idle',
  walk: 'Walk',
  walking: 'Walk',
  awlk: 'Walk',
  run: 'Run',
  roar: 'Roar',
  attack: 'Attack',
  fight: 'Attack',
  rangeattack: 'Ranged attack',
  directionattack: 'Aimed attack',
  buturi: 'Physical move',
  tokusyu: 'Special move',
  damage: 'Hurt',
  stun: 'Stunned',
  down: 'Faint',
  faint: 'Faint',
  ko: 'Faint',
  glad: 'Happy',
  hate: 'Angry',
  notice: 'Notice',
  refresh: 'Shake off',
  sleep: 'Sleep',
  sleeploop: 'Sleep',
  eat: 'Eat',
  rest: 'Rest',
  search: 'Search',
  lookaround: 'Look around',
  charge: 'Charge',
  appeal: 'Pose',
  megaappeal: 'Mega pose',
  formchange: 'Form change',
  jumpup: 'Jump',
  jumpdown: 'Fall',
  jump: 'Jump',
  land: 'Land',
  landa: 'Land',
  landing: 'Land',
  stepin: 'Step in',
  stepout: 'Step out',
  stepleft: 'Step left',
  stepright: 'Step right',
  turnmove: 'Turn and move',
  eye: 'Blink',
  mouth: 'Mouth',
  appear: 'Appear',
  appearloop: 'Appear',
  letsgo: "Let's go",
  fly: 'Fly',
  dancing: 'Dance',
  yes: 'Nod',
  loop: 'Loop',
  impactrueno: 'Thunderbolt', // Spanish name of the move
};

const PHRASES: [RegExp, string][] = [
  [/turnmove\d*_l/, 'Turn left and move'],
  [/turnmove\d*_r/, 'Turn right and move'],
  [/merge_default_battle/, 'Enter battle stance'],
  [/merge_battle_default/, 'Leave battle stance'],
  [/turn_l\d+/, 'Turn left'],
  [/turn_r0*[1-9]\d*/, 'Turn right'],
  [/turn_r0+$/, 'Turn'],
];

// Segments of "a|b|c" names that are rig plumbing, not the action.
const NOISE_SEGMENT = /^(armature(\.\d+)?|base ?lay(er?)?(\.\d+)?|model_skeleton|pt_.*|tail|take \d+|[a-z]+_\d+)$/i;
// Generic exporter names with no information ("ArmatureAction", "rigAction", "Scene").
const GENERIC = /^(.*action|animation|animated|take \d+|static pose|scene)$/i;

/** "Pikachu" → ["pikachu"]: species words that some clip names start with ("kartana_idle"). */
function speciesWords(species: string): string[] {
  return species.toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

/** True if `a` equals `b` or differs by one inserted/deleted/changed letter ("chariard"). */
function nearlyEqual(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 4) return a === b;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(i + (a.length >= b.length ? 1 : 0)) === b.slice(i + (b.length >= a.length ? 1 : 0));
}

/** Readable label for a clip, or null when the name carries no meaning. */
export function clipLabel(rawName: string, species = ''): string | null {
  const segments = rawName.split('|').map((s) => s.trim()).filter(Boolean);
  let name = [...segments].reverse().find((s) => !NOISE_SEGMENT.test(s)) ?? segments.at(-1) ?? '';
  // Game rips number battle-mode variants 2xxxx ("pm0149_00_00_20030_walk01_loop").
  const battle = /^pm\d+_\d+_\d+_2\d{4}_/i.test(name) && !/battle/i.test(name) ? ' (battle)' : '';
  name = name
    .replace(/\.(\d+|gfbanm)$/i, '') // exporter duplicates / extensions
    .replace(/\s+RSU$/i, '')
    .replace(/\s+\w{1,2}\/.*$/, '') // "walk01_loop w/ run In Place"
    .replace(/\/.*$/, '') // "rangeattack01/ range"
    .replace(/^pm\d+_\d+_\d+_(\d+_)?/i, '') // game model prefix
    .replace(/^_*o_obj_/i, '')
    .replace(/^bd_/i, '')
    .replace(/^ev_?\d*_?/i, '')
    .replace(/^\d+/, '') // "001aidle"
    .replace(/^ba\d+_/i, '')
    .trim();
  const words = speciesWords(species);
  name = name
    .split(/[\s_]+/)
    .filter((w) => !words.some((s) => nearlyEqual(w.toLowerCase(), s)))
    .join('_');
  if (!name || GENERIC.test(name.replace(/_/g, ' '))) return null;

  const lower = name.toLowerCase();
  const suffix = battle + (lower.endsWith('_start') ? ' (start)' : lower.endsWith('_end') ? ' (end)' : '');
  const core = lower.replace(/_(start|end|loop)$/, '').replace(/_loop$/, '');

  for (const [pattern, label] of PHRASES) {
    if (pattern.test(core)) return label + suffix;
  }
  // "attack02" → "Attack 2", "stakataka_attack1" → "Attack 1"
  const m = core.match(/^([a-z]+?)(?:_?0*(\d+))?(?:_([a-z]))?$/);
  if (m) {
    const [, word, number, variant] = m;
    const base = WORDS[word] ?? word.charAt(0).toUpperCase() + word.slice(1);
    const n = number && Number(number) > 1 ? ` ${Number(number)}` : '';
    const v = variant ? ` ${variant.toUpperCase()}` : '';
    return `${base}${n}${v}${suffix}`;
  }
  const text = core.replace(/\d+/g, '').replace(/_+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1) + suffix;
}

/** Labels for every clip; unnamed or duplicate labels are numbered so each stays distinct. */
export function clipLabels(names: string[], species = ''): string[] {
  const labels = names.map((n, i) => clipLabel(n, species) ?? `Animation ${i + 1}`);
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return count > 1 ? `${label} (${count})` : label;
  });
}

// Most specific first: a looping idle beats a one-off fidget.
const IDLE_PATTERNS = [/defaultwait/i, /waita/i, /(^|[^a-z])(a?idle|idol)($|[^a-z])/i, /wait/i, /idle/i, /stand/i];

/** Index of the clip that should loop while the Pokémon stands still, or -1. */
export function idleClipIndex(names: string[]): number {
  for (const pattern of IDLE_PATTERNS) {
    const i = names.findIndex((n) => pattern.test(n) && !/battle/i.test(n));
    if (i >= 0) return i;
  }
  return -1;
}
