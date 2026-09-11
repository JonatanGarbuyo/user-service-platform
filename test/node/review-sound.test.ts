import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  commandExists,
  playSoundSpec,
  ringTerminalNotification,
  selectSoundSpec,
} from '../../scripts/review/bell.js';

// Seam under test: platform-aware audible notification (final acceptance
// follow-up on PR #19). BEL alone is terminal-emulator dependent, so terminal
// states additionally play a local sound where a supported mechanism exists,
// keeping BEL as the baseline. Policy (--no-bell, CI, non-TTY silence),
// best-effort playback (never fails the cycle), and selection/fallback are
// all deterministic without real audio hardware via injected seams.
describe('audible sound selection', () => {
  const yes = () => true;
  const no = () => false;

  it('selects afplay with the system sound on macOS when available', () => {
    expect(selectSoundSpec('darwin', yes, yes)).toEqual({
      command: 'afplay',
      args: ['/System/Library/Sounds/Glass.aiff'],
    });
  });

  it('falls back to BEL-only on macOS without afplay', () => {
    expect(selectSoundSpec('darwin', yes, no)).toBeNull();
  });

  it('falls back to BEL-only on macOS without the sound file', () => {
    expect(selectSoundSpec('darwin', no, yes)).toBeNull();
  });

  it('selects paplay with the freedesktop sound on Linux when available', () => {
    expect(
      selectSoundSpec(
        'linux',
        (file) => file.endsWith('.oga'),
        (cmd) => cmd === 'paplay',
      ),
    ).toEqual({
      command: 'paplay',
      args: ['/usr/share/sounds/freedesktop/stereo/complete.oga'],
    });
  });

  it('tries aplay as a Linux fallback when paplay is unavailable', () => {
    expect(
      selectSoundSpec(
        'linux',
        (file) => file.endsWith('.wav'),
        (cmd) => cmd === 'aplay',
      ),
    ).toEqual({
      command: 'aplay',
      args: ['/usr/share/sounds/alsa/Front_Center.wav'],
    });
  });

  it('falls back to BEL-only on Linux without any supported player/sound', () => {
    expect(selectSoundSpec('linux', no, no)).toBeNull();
  });

  it('falls back to BEL-only on unsupported platforms', () => {
    expect(selectSoundSpec('win32', yes, yes)).toBeNull();
  });
});

describe('sound playback', () => {
  it('never throws when the player binary is missing', () => {
    const spawn = vi.fn(() => {
      throw new Error('spawn ENOENT');
    });

    expect(() => {
      playSoundSpec({ command: 'paplay', args: ['complete.oga'] }, spawn);
    }).not.toThrow();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('swallows asynchronous player errors without failing the cycle', () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;

    expect(() => {
      playSoundSpec({ command: 'paplay', args: ['complete.oga'] }, () => child);
    }).not.toThrow();
    expect(() => {
      child.emit('error', new Error('audio device busy'));
    }).not.toThrow();
  });
});

describe('command detection', () => {
  it('finds an executable on PATH and misses an absent one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-sound-'));
    const probe = path.join(dir, 'fake-player');
    fs.writeFileSync(probe, '#!/bin/sh\n');
    fs.chmodSync(probe, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath ?? ''}`;
    try {
      expect(commandExists('fake-player')).toBe(true);
      expect(commandExists('definitely-not-a-player')).toBe(false);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('audible terminal notification', () => {
  const silentPolicy = { noBell: true, isTTY: true, isCI: false };
  const livePolicy = { noBell: false, isTTY: true, isCI: false };

  it('emits nothing when the bell policy forbids it', () => {
    const write = vi.fn();
    const spawnSound = vi.fn();

    ringTerminalNotification(silentPolicy, { write, spawnSound });

    expect(write).not.toHaveBeenCalled();
    expect(spawnSound).not.toHaveBeenCalled();
  });

  it('writes BEL without spawning sound when no player is available', () => {
    const write = vi.fn();
    const spawnSound = vi.fn();

    ringTerminalNotification(livePolicy, {
      write,
      spawnSound,
      platform: 'linux',
      exists: () => false,
      canRun: () => false,
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('\x07');
    expect(spawnSound).not.toHaveBeenCalled();
  });

  it('writes BEL and plays sound once when a player is available', () => {
    const write = vi.fn();
    const spawnSound = vi.fn();

    ringTerminalNotification(livePolicy, {
      write,
      spawnSound,
      platform: 'darwin',
      exists: () => true,
      canRun: () => true,
    });

    expect(write).toHaveBeenCalledWith('\x07');
    expect(spawnSound).toHaveBeenCalledTimes(1);
    expect(spawnSound).toHaveBeenCalledWith('afplay', ['/System/Library/Sounds/Glass.aiff']);
  });

  it('still writes BEL when sound playback throws', () => {
    const write = vi.fn();

    expect(() => {
      ringTerminalNotification(livePolicy, {
        write,
        platform: 'darwin',
        exists: () => true,
        canRun: () => true,
        spawnSound: () => {
          throw new Error('no audio');
        },
      });
    }).not.toThrow();
    expect(write).toHaveBeenCalledWith('\x07');
  });
});
