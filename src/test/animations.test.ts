import { describe, expect, it } from 'vitest';
import { clipLabel, clipLabels, idleClipIndex } from '../animations';

describe('clipLabel', () => {
  it.each([
    ['pm0646_13_00_00400_attack01', 'Attack'],
    ['pm0646_13_00_00410_attack02', 'Attack 2'],
    ['pm0883_00_00|pm0883_00_00_00030_walk01_loop', 'Walk'],
    ['pm0646_13_00_00000_defaultwait01_loop', 'Idle'],
    ['pm0646_13_00_00280_sleep01_start', 'Sleep (start)'],
    ['pm0646_13_00_00522_down01_end', 'Faint (end)'],
    ['pm0646_13_00_00024_turn_l090', 'Turn left'],
    ['pm0883_00_00_00026_turnmove01_r090', 'Turn right and move'],
    ['pm0646_13_00_00800_merge_default_battle01', 'Enter battle stance'],
    ['Armature|Armature|pm0887_00_00_ba20_buturi01|Base Layer', 'Physical move'],
    ['Armature|Armature|pm0887_00_00_ba10_waitA01|Base Layer', 'Idle'],
    ['Armature|Armature|Armature|Armature|pm0145_12_00_ba21_tokusyu01|Base Laye', 'Special move'],
    ['model_skeleton|001aidle', 'Idle'],
    ['model_skeleton|001fight_b', 'Attack B'],
    ['PT_R_hand|bd_letsgo|Base Layer', "Let's go"],
    ['faiyaa_10|bd_appear|Base Layer', 'Appear'],
    ['Shiny|walk01_loop w/ run In Place', 'Walk'],
    ['rangeattack01/ range', 'Ranged attack'],
    ['Impactrueno', 'Thunderbolt'],
    ['pm0149_00_00_20030_walk01_loop', 'Walk (battle)'],
    ['pm0149_00_00_20001_battlewait01_loop', 'Battle stance'],
  ])('%s → %s', (name, label) => {
    expect(clipLabel(name)).toBe(label);
  });

  it('drops the species name some clips start with', () => {
    expect(clipLabel('kartana_attack1', 'Kartana')).toBe('Attack');
    expect(clipLabel('rattata awlk', 'Rattata')).toBe('Walk');
    // Misspelled in the model file.
    expect(clipLabel('Chariard_dizzy', 'Charizard')).toBe('Dizzy');
  });

  it.each(['ArmatureAction', 'Armature|ArmatureAction', 'ArmatureAction.001', 'Animation', 'Take 001', 'Normal|Static Pose'])(
    'returns null for the generic name %s',
    (name) => {
      expect(clipLabel(name)).toBeNull();
    },
  );
});

describe('clipLabels', () => {
  it('numbers generic and duplicate names', () => {
    expect(clipLabels(['ArmatureAction', 'attack01', 'attack01.001'])).toEqual(['Animation 1', 'Attack', 'Attack (2)']);
  });
});

describe('idleClipIndex', () => {
  it('prefers the looping idle over fidgets and battle stances', () => {
    const names = [
      'pm0646_13_00_00001_battlewait01_loop',
      'pm0646_13_00_00010_defaultidle01',
      'pm0646_13_00_00000_defaultwait01_loop',
    ];
    expect(idleClipIndex(names)).toBe(2);
  });

  it.each([
    [['model_skeleton|001aidle', 'model_skeleton|001run'], 0],
    [['Idol', 'Walking', 'Attack'], 0],
    [['kartana_attack1', 'kartana_idle'], 1],
    [['Armature|Armature|pm0887_00_00_ba02_roar01|Base Layer', 'Armature|Armature|pm0887_00_00_ba10_waitA01|Base Layer'], 1],
    [['Impactrueno'], -1],
    [['Chariard_dizzy'], -1],
  ])('%j → %i', (names, index) => {
    expect(idleClipIndex(names)).toBe(index);
  });
});
