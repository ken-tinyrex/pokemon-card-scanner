// The Pixi scene: background glow, particles and burst effects, with the
// Pokémon rendered by three.js into an offscreen canvas and shown as a Pixi sprite.
//
// Pixi is 2D-only and can't decode the API's Draco-compressed glTF models,
// so three.js does the 3D work and Pixi composites the result every frame.

import { Application, BlurFilter, CanvasSource, Container, Graphics, Sprite, Texture } from 'pixi.js';
import {
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  Box3,
  Group,
  HemisphereLight,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  MathUtils,
  Color,
  type Mesh,
  Quaternion,
  type Object3D,
  Texture as ThreeTexture,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clipLabels, idleClipIndex } from './animations';
import { relaxTPose } from './pose';

const DRACO_DECODER_URL = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';
const DEFAULT_ACCENT = 0x7cc4ff;
const MODEL_HEIGHT = 2;
const FOV = 35;

interface Particle {
  sprite: Sprite;
  speed: number;
  drift: number;
  phase: number;
}

interface Ring {
  g: Graphics;
  age: number;
}

const FADE_SECONDS = 0.3;

export interface AnimationState {
  /** Readable name of each clip, by index. */
  labels: string[];
  /** Index of the clip used as the idle loop, or -1 (then idle is a still pose that "breathes"). */
  idleIndex: number;
  /** The clip playing, or null while idling. */
  active: number | null;
  playingAll: boolean;
}

const easeOutBack = (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;

function disposeObject(root: Object3D) {
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const material of [mesh.material].flat()) {
      for (const value of Object.values(material)) {
        if (value instanceof ThreeTexture) value.dispose();
      }
      material.dispose();
    }
  });
}

/**
 * Walk and run clips carry the Pokémon forward (root motion), which would walk it off stage.
 * Any bone whose position drifts across a clip (ends far from where it started, unlike sway)
 * is pinned horizontally to its first frame. Vertical motion is kept, so jumps still work.
 */
function keepInPlace(clip: AnimationClip, model: Object3D) {
  model.updateMatrixWorld(true);
  for (const track of clip.tracks) {
    const [nodeName, property] = track.name.split('.');
    const parent = model.getObjectByName(nodeName)?.parent;
    const frames = track.values.length / 3;
    if (property !== 'position' || !parent || frames < 2) continue;
    // Converted rigs are often rotated (Z-up), so find which local axis points up.
    const up = new Vector3(0, 1, 0).applyQuaternion(parent.getWorldQuaternion(new Quaternion()).invert());
    const upAxis = [Math.abs(up.x), Math.abs(up.y), Math.abs(up.z)].reduce((best, v, i, all) => (v > all[best] ? i : best), 0);
    for (const axis of [0, 1, 2].filter((a) => a !== upAxis)) {
      const values = track.values;
      let min = Infinity;
      let max = -Infinity;
      for (let f = 0; f < frames; f++) {
        min = Math.min(min, values[f * 3 + axis]);
        max = Math.max(max, values[f * 3 + axis]);
      }
      const drift = Math.abs(values[(frames - 1) * 3 + axis] - values[axis]);
      if (max - min < 1e-6 || drift < 0.5 * (max - min)) continue;
      for (let f = 1; f < frames; f++) values[f * 3 + axis] = values[axis];
    }
  }
}

export class PokemonStage {
  private app = new Application();
  private threeCanvas = document.createElement('canvas');
  private renderer3d!: WebGLRenderer;
  private scene3d = new Scene();
  private camera = new PerspectiveCamera(FOV, 1, 0.05, 100);
  private controls!: OrbitControls;
  private loader = new GLTFLoader();
  private mixer: AnimationMixer | null = null;
  private clips: AnimationClip[] = [];
  private labels: string[] = [];
  private idleIndex = -1;
  /** What plays while idle: the idle clip looping, or a paused first frame as a still pose. */
  private restAction: AnimationAction | null = null;
  private currentAction: AnimationAction | null = null;
  private activeClip: number | null = null;
  private playingAll = false;
  /** Called whenever the available or playing animations change. */
  onAnimationChange?: (state: AnimationState) => void;
  private model: Group | null = null;
  private popAge = 1;
  private breathing = false;
  /** Size of the current model in world units (a placeholder before the first scan). */
  private modelSize = { height: MODEL_HEIGHT, width: MODEL_HEIGHT };
  private loadToken = 0;

  private modelSprite = new Sprite();
  private glow = new Graphics();
  private backParticles = new Container();
  private frontParticles = new Container();
  private rings = new Container();
  private particles: Particle[] = [];
  private activeRings: Ring[] = [];
  private accent = new Color(DEFAULT_ACCENT);
  private targetAccent = new Color(DEFAULT_ACCENT);
  private time = 0;
  /** Screen space (CSS px) covered by UI at the top and bottom, kept clear of the model. */
  private insets = { top: 0, bottom: 0 };

  static async create(container: HTMLElement): Promise<PokemonStage> {
    const stage = new PokemonStage();
    await stage.init(container);
    return stage;
  }

  private async init(container: HTMLElement) {
    await this.app.init({
      resizeTo: container,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio, 2),
    });
    container.appendChild(this.app.canvas);

    this.renderer3d = new WebGLRenderer({
      canvas: this.threeCanvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.renderer3d.setClearColor(0x000000, 0);

    const draco = new DRACOLoader().setDecoderPath(DRACO_DECODER_URL);
    this.loader.setDRACOLoader(draco);

    this.scene3d.add(new HemisphereLight(0xffffff, 0x445066, 2.2));
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 5, 4);
    const rim = new DirectionalLight(0xbfd9ff, 1.2);
    rim.position.set(-4, 3, -4);
    this.scene3d.add(key, rim);

    this.camera.position.set(0, 1.4, 6);
    this.controls = new OrbitControls(this.camera, this.app.canvas);
    this.controls.target.set(0, MODEL_HEIGHT / 2, 0);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    // Mouse wheel and pinch zoom; limits are set per model in frameCamera().
    this.controls.enableZoom = true;
    this.controls.zoomSpeed = 0.8;
    // Sideways-only rotation: lock the vertical angle to the starting one.
    const polar = Math.acos(this.camera.position.clone().sub(this.controls.target).normalize().y);
    this.controls.minPolarAngle = polar;
    this.controls.maxPolarAngle = polar;

    this.glow.filters = [new BlurFilter({ strength: 24, quality: 4 })];
    this.glow.blendMode = 'add';
    this.backParticles.blendMode = 'add';
    this.frontParticles.blendMode = 'add';
    this.rings.blendMode = 'add';
    this.app.stage.addChild(this.backParticles, this.glow, this.modelSprite, this.frontParticles, this.rings);
    this.createParticles();

    this.app.renderer.on('resize', () => this.resize());
    this.resize();
    // Normal priority runs before Pixi's own render, so the 3D frame is fresh when composited.
    this.app.ticker.add((ticker) => this.update(ticker.deltaMS / 1000));
  }

  private createParticles() {
    // Soft dot: stacked circles fake a radial falloff.
    const dot = new Graphics();
    for (let r = 8; r > 0; r--) dot.circle(0, 0, r).fill({ color: 0xffffff, alpha: 0.14 });
    const texture = this.app.renderer.generateTexture({ target: dot, resolution: 2 });
    for (let i = 0; i < 70; i++) {
      const sprite = new Sprite({ texture, anchor: 0.5 });
      const front = i % 3 === 0;
      sprite.scale.set(front ? 0.35 + Math.random() * 0.5 : 0.2 + Math.random() * 0.35);
      sprite.position.set(Math.random() * this.app.screen.width, Math.random() * this.app.screen.height);
      (front ? this.frontParticles : this.backParticles).addChild(sprite);
      this.particles.push({ sprite, speed: 12 + Math.random() * 30, drift: Math.random() * 20, phase: Math.random() * Math.PI * 2 });
    }
  }

  private resize() {
    const { width, height } = this.app.screen;
    this.renderer3d.setPixelRatio(this.app.renderer.resolution);
    this.renderer3d.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.frameCamera();

    // The canvas changed size, so its GPU texture must be recreated.
    const old = this.modelSprite.texture;
    this.modelSprite.texture = new Texture({
      source: new CanvasSource({ resource: this.threeCanvas, resolution: this.app.renderer.resolution }),
    });
    this.modelSprite.setSize(width, height);
    if (old !== Texture.EMPTY) old.destroy(true);
  }

  /** Keeps the model inside the part of the screen not covered by UI. */
  setInsets(top: number, bottom: number) {
    this.insets = { top, bottom };
    this.frameCamera();
  }

  /** Fits the model into the free band between the insets at any aspect ratio. */
  private frameCamera() {
    const { width, height } = this.app.screen;
    const band = Math.max(height * 0.35, height - this.insets.top - this.insets.bottom);
    const halfFov = MathUtils.degToRad(FOV / 2);
    const fitHeight = ((this.modelSize.height * 1.45) / 2 / Math.tan(halfFov)) * (height / band);
    const fitWidth = (this.modelSize.width * 1.1) / 2 / (Math.tan(halfFov) * this.camera.aspect);
    const distance = Math.max(fitHeight, fitWidth);
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(direction, distance);
    this.controls.minDistance = distance * 0.4;
    this.controls.maxDistance = distance * 2;
    // Shift the rendered view so the model is centred in the free band, not the screen.
    const shift = (this.insets.bottom - this.insets.top) / 2;
    this.camera.setViewOffset(width, height, 0, Math.min(shift, (height - band) / 2), width, height);
  }

  setAccent(color: number | null) {
    this.targetAccent.set(color ?? DEFAULT_ACCENT);
  }

  /**
   * Loads a glTF model URL and swaps it in. Rejects if loading fails.
   * `species` helps turn clip names like "kartana_attack1" into "Attack".
   */
  async show(url: string, { species = '', onProgress }: { species?: string; onProgress?: (fraction: number) => void } = {}): Promise<void> {
    const token = ++this.loadToken;
    const gltf = await this.loader.loadAsync(url, (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    });
    if (token !== this.loadToken) return; // A newer scan replaced this one.

    if (this.model) {
      this.scene3d.remove(this.model);
      disposeObject(this.model);
    }
    this.mixer?.stopAllAction();
    const model = gltf.scene;
    this.setupAnimations(model, gltf.animations, species);

    // Rigged models without any clips show their bind pose, often a T-pose.
    if (this.clips.length === 0) {
      model.updateMatrixWorld(true);
      relaxTPose(model, new Box3().setFromObject(model, true).getSize(new Vector3()).y);
    }

    // Measure the posed (skinned) mesh, then fit it to a standard height on the ground.
    model.updateMatrixWorld(true);
    const box = new Box3().setFromObject(model, true);
    const size = box.getSize(new Vector3());
    const scale = Math.min(MODEL_HEIGHT / size.y, (MODEL_HEIGHT * 1.3) / Math.max(size.x, size.z));
    model.scale.setScalar(scale);
    const center = box.getCenter(new Vector3()).multiplyScalar(scale);
    model.position.set(-center.x, -box.min.y * scale, -center.z);
    this.modelSize = { height: size.y * scale, width: Math.max(size.x, size.z) * scale };
    this.controls.target.set(0, this.modelSize.height / 2, 0);
    this.frameCamera();

    const pivot = new Group();
    pivot.add(model);
    this.scene3d.add(pivot);
    this.model = pivot;

    this.popAge = 0;
    this.burst();
    this.emitAnimationState();
  }

  /**
   * Idles with the model's idle clip if it has one. Otherwise it holds the first frame of any
   * clip (the bind pose can be odd, e.g. Pikachu lying flat) with a procedural breathing motion.
   */
  private setupAnimations(model: Object3D, clips: AnimationClip[], species: string) {
    clips.forEach((clip) => keepInPlace(clip, model));
    this.clips = clips;
    this.labels = clipLabels(clips.map((c) => c.name), species);
    this.idleIndex = idleClipIndex(clips.map((c) => c.name));
    this.playingAll = false;
    this.activeClip = null;
    this.mixer = null;
    this.restAction = null;
    this.currentAction = null;
    this.breathing = this.idleIndex < 0;
    if (clips.length === 0) return;

    this.mixer = new AnimationMixer(model);
    this.mixer.addEventListener('finished', (e) => {
      if (this.playingAll && e.action === this.currentAction) this.playNextInSequence();
    });
    // A cloned clip gets its own action, so the pose stays separate from playing that clip.
    const restClip = this.idleIndex >= 0 ? clips[this.idleIndex] : clips[0].clone();
    this.restAction = this.mixer.clipAction(restClip).play();
    this.restAction.paused = this.idleIndex < 0;
    this.currentAction = this.restAction;
    this.mixer.update(0);
  }

  /** Plays one clip on repeat, or returns to idle with `null`. Stops "play all". */
  playAnimation(index: number | null) {
    this.playingAll = false;
    this.startClip(index, { once: false });
  }

  /** Plays every clip once in turn, repeating the sequence until stopped. */
  playAllAnimations(on: boolean) {
    if (!on || this.clips.length === 0) {
      this.playAnimation(null);
      return;
    }
    this.playingAll = true;
    this.activeClip = null;
    this.playNextInSequence();
  }

  private playNextInSequence() {
    let next = ((this.activeClip ?? -1) + 1) % this.clips.length;
    // The idle loop is what plays between clips anyway, so the sequence skips it.
    if (next === this.idleIndex && this.clips.length > 1) next = (next + 1) % this.clips.length;
    this.startClip(next, { once: true });
  }

  private startClip(index: number | null, { once }: { once: boolean }) {
    if (!this.mixer || !this.restAction) return;
    const clip = index === null ? null : this.clips[index];
    const action = clip ? this.mixer.clipAction(clip) : this.restAction;
    const isStillPose = action === this.restAction && this.idleIndex < 0;

    action.reset();
    if (once && clip) {
      // Very short loops (a single step, a blink) are repeated so they register.
      action.setLoop(clip.duration < 1.2 ? LoopRepeat : LoopOnce, clip.duration < 1.2 ? 2 : 1);
      action.clampWhenFinished = true;
    } else {
      action.setLoop(LoopRepeat, Infinity);
      action.clampWhenFinished = false;
    }
    if (action !== this.currentAction) {
      action.fadeIn(FADE_SECONDS);
      this.currentAction?.fadeOut(FADE_SECONDS);
    }
    action.play();
    action.paused = isStillPose;

    this.currentAction = action;
    this.activeClip = index;
    this.breathing = isStillPose;
    this.emitAnimationState();
  }

  private emitAnimationState() {
    this.onAnimationChange?.({
      labels: this.labels,
      idleIndex: this.idleIndex,
      active: this.activeClip,
      playingAll: this.playingAll,
    });
  }

  /** Expanding rings from the Pokémon's feet. */
  private burst() {
    for (let i = 0; i < 3; i++) {
      const g = new Graphics();
      this.rings.addChild(g);
      this.activeRings.push({ g, age: -i * 0.12 });
    }
  }

  private groundPoint(): { x: number; y: number; radius: number } {
    const project = (v: Vector3) => {
      v.project(this.camera);
      return { x: (v.x * 0.5 + 0.5) * this.app.screen.width, y: (-v.y * 0.5 + 0.5) * this.app.screen.height };
    };
    const center = project(new Vector3(0, 0, 0));
    const edge = project(this.camera.position.clone().setY(0).normalize().cross(new Vector3(0, 1, 0)).multiplyScalar(this.modelSize.width * 0.55));
    return { ...center, radius: Math.hypot(edge.x - center.x, edge.y - center.y) };
  }

  private update(dt: number) {
    this.time += dt;
    this.accent.lerp(this.targetAccent, Math.min(1, dt * 3));
    const tint = this.accent.getHex();

    this.controls.update(dt);
    this.mixer?.update(dt);
    if (this.model) {
      this.popAge = Math.min(1, this.popAge + dt / 0.7);
      const pop = Math.max(0.001, easeOutBack(this.popAge));
      const breath = this.breathing ? Math.sin(this.time * 2.4) * 0.018 : 0;
      this.model.scale.set(pop * (1 - breath / 2), pop * (1 + breath), pop * (1 - breath / 2));
    }
    this.renderer3d.render(this.scene3d, this.camera);
    this.modelSprite.texture.source.update();

    const { width, height } = this.app.screen;
    const ground = this.groundPoint();
    const pulse = 1 + Math.sin(this.time * 2) * 0.05;
    this.glow
      .clear()
      .ellipse(ground.x, ground.y, ground.radius * 1.3 * pulse, ground.radius * 0.38 * pulse)
      .fill({ color: tint, alpha: this.model ? 0.75 : 0.4 })
      .ellipse(ground.x, ground.y - ground.radius * 0.9, ground.radius * 0.9, ground.radius * 1.5)
      .fill({ color: tint, alpha: this.model ? 0.12 : 0.06 });

    for (const p of this.particles) {
      const s = p.sprite;
      s.y -= p.speed * dt;
      s.x += Math.sin(this.time + p.phase) * p.drift * dt;
      s.alpha = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(this.time * 1.7 + p.phase));
      s.tint = tint;
      if (s.y < -10) {
        s.y = height + 10;
        s.x = Math.random() * width;
      }
      if (s.x > width + 10) s.x = -10;
      if (s.x < -10) s.x = width + 10;
    }

    this.activeRings = this.activeRings.filter((ring) => {
      ring.age += dt;
      const t = Math.max(0, ring.age) / 0.9;
      if (t >= 1) {
        ring.g.destroy();
        return false;
      }
      const r = ground.radius * (0.4 + t * 2.4);
      ring.g
        .clear()
        .ellipse(ground.x, ground.y, r, r * 0.3)
        .stroke({ color: tint, width: 6 * (1 - t) + 1, alpha: (1 - t) * 0.9 });
      return true;
    });
  }
}
