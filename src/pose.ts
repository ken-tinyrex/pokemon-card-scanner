// Relaxes T-posed arms on rigged models that ship without any animation.

import { type Bone, type Object3D, Quaternion, Vector3 } from 'three';

type Side = 'L' | 'R';

// Upper-arm bone names seen in the assets: "LArm", "050 LArm", "LArm_018", "L_UpperArm",
// "left_arm_01_082". "LArm2" is a second pair of arms (Machamp, Kangaskhan's baby).
// three.js replaces spaces in node names with underscores ("050_LArm").
const UPPER_ARM_PATTERNS: [RegExp, (m: RegExpMatchArray) => Side][] = [
  [/^(?:\d+[\s_])?([LR])Arm\d?(?:_\d+)?$/, (m) => m[1] as Side],
  [/^([LR])_UpperArm(?:_\d+)?$/, (m) => m[1] as Side],
  [/^(left|right)_arm_01(?:_\d+)*$/, (m) => (m[1] === 'left' ? 'L' : 'R')],
];

interface Arm {
  bone: Bone;
  side: Side;
  /** World-space direction from the shoulder joint to the elbow. */
  direction: Vector3;
  /** World position of the end of the arm chain (hand, or wing/fin tip). */
  tip: Vector3;
}

function chainTip(bone: Object3D): Object3D {
  let node = bone;
  for (let depth = 0; depth < 6; depth++) {
    const next = node.children.find((c) => (c as Bone).isBone);
    if (!next) break;
    node = next;
  }
  return node;
}

function findArms(root: Object3D): Arm[] {
  const arms: Arm[] = [];
  root.traverse((node) => {
    if (!(node as Bone).isBone) return;
    for (const [pattern, side] of UPPER_ARM_PATTERNS) {
      const m = node.name.match(pattern);
      const child = node.children.find((c) => (c as Bone).isBone);
      if (!m || !child) continue;
      const shoulder = node.getWorldPosition(new Vector3());
      const elbow = child.getWorldPosition(new Vector3());
      const direction = elbow.clone().sub(shoulder);
      if (direction.lengthSq() === 0) continue;
      const tip = chainTip(node).getWorldPosition(new Vector3());
      arms.push({ bone: node as Bone, side: side(m), direction: direction.normalize(), tip });
      break;
    }
  });
  return arms;
}

// Rigs authored in a T-pose have arms that are almost exactly horizontal; arms that
// rest outstretched by design (Starmie, Aerodactyl, Mew) are tilted.
const T_POSE_MAX_TILT = 0.06;
// Wings can also be rigged flat. They span wider than the body is tall and have no fingers.
const MAX_ARM_SPAN_WITHOUT_FINGERS = 1;
const RELAXED_ANGLE = (55 * Math.PI) / 180;
const DOWN = new Vector3(0, -1, 0);

function hasFingers(bone: Object3D): boolean {
  let found = false;
  bone.traverse((node) => {
    if (/finger|thumb/i.test(node.name)) found = true;
  });
  return found;
}

/** Widest distance between a left and a right arm tip. */
function span(arms: Arm[]): number {
  let widest = 0;
  for (const l of arms.filter((a) => a.side === 'L')) {
    for (const r of arms.filter((a) => a.side === 'R')) widest = Math.max(widest, l.tip.distanceTo(r.tip));
  }
  return widest;
}

/** Rotates an arm in world space so it points `angle` radians below horizontal. */
function lowerArm({ bone, direction }: Arm, angle: number) {
  const axis = new Vector3().crossVectors(direction, DOWN);
  if (axis.lengthSq() < 1e-8 || !bone.parent) return;
  const elevation = Math.asin(Math.max(-1, Math.min(1, direction.y)));
  const turn = new Quaternion().setFromAxisAngle(axis.normalize(), elevation + angle);
  const parentWorld = bone.parent.getWorldQuaternion(new Quaternion());
  const boneWorld = bone.getWorldQuaternion(new Quaternion());
  bone.quaternion.copy(parentWorld.invert().multiply(turn).multiply(boneWorld));
}

/**
 * Lowers T-posed arms on a model in its bind pose. Leaves wings, fins and arms that are
 * meant to be outstretched alone. Returns true if the pose was changed.
 */
export function relaxTPose(root: Object3D, modelHeight: number): boolean {
  root.updateMatrixWorld(true);
  const arms = findArms(root);
  const flat = arms.filter((a) => Math.abs(a.direction.y) < T_POSE_MAX_TILT);
  if (flat.length === 0) return false;
  const armLike = flat.some((a) => hasFingers(a.bone)) || span(arms) / modelHeight < MAX_ARM_SPAN_WITHOUT_FINGERS;
  if (!armLike) return false;
  for (const arm of flat) lowerArm(arm, RELAXED_ANGLE);
  root.updateMatrixWorld(true);
  return true;
}
