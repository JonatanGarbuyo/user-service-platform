// Audible terminal notification for terminal review-cycle states (ticket #18).
// The notification fires only for terminal states in interactive TTY use and
// never in CI/non-TTY. BEL alone is terminal-emulator dependent, so an
// actually audible local sound plays where a supported mechanism exists, with
// BEL kept as the always-on baseline. Headless agents do not depend on it:
// human-required decisions are surfaced as explicit escalation output, never
// as hidden stdin prompts.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const TERMINAL_BELL = '\x07';

export interface BellPolicy {
  noBell: boolean;
  isTTY: boolean;
  isCI: boolean;
}

export function shouldRingBell(policy: BellPolicy): boolean {
  if (policy.noBell) {
    return false;
  }
  if (policy.isCI) {
    return false;
  }
  return policy.isTTY;
}

export type BellWriter = (output: string) => void;

export function notifyTerminalState(policy: BellPolicy, write: BellWriter): void {
  if (!shouldRingBell(policy)) {
    return;
  }
  write(TERMINAL_BELL);
}

export function currentBellPolicy(noBell: boolean): BellPolicy {
  return {
    noBell,
    isTTY: process.stdout.isTTY,
    isCI: process.env.CI !== undefined && process.env.CI !== '',
  };
}

export function notifyTerminalBell(noBell: boolean): void {
  ringTerminalNotification(currentBellPolicy(noBell));
}

// Platform-aware audible playback (final acceptance follow-up on PR #19).
// A small notifier is sufficient: use an available local sound command on
// macOS/Linux, then fall back to BEL-only elsewhere. Sound playback is always
// best-effort and never a reason for the review cycle to fail.
export interface SoundSpec {
  command: string;
  args: readonly string[];
}

const MACOS_SOUND = '/System/Library/Sounds/Glass.aiff';
const LINUX_PAPLAY_SOUND = '/usr/share/sounds/freedesktop/stereo/complete.oga';
const LINUX_CANBERRA_ARGS = ['--id=complete', '--description=Review cycle complete'] as const;

export type FileExists = (filePath: string) => boolean;
export type CommandAvailable = (command: string) => boolean;

export function selectSoundSpec(
  platform: string,
  exists: FileExists,
  canRun: CommandAvailable,
): SoundSpec | null {
  if (platform === 'darwin') {
    if (canRun('afplay') && exists(MACOS_SOUND)) {
      return { command: 'afplay', args: [MACOS_SOUND] };
    }
    return null;
  }
  if (platform === 'linux') {
    if (canRun('canberra-gtk-play')) {
      return { command: 'canberra-gtk-play', args: [...LINUX_CANBERRA_ARGS] };
    }
    if (canRun('paplay') && exists(LINUX_PAPLAY_SOUND)) {
      return { command: 'paplay', args: [LINUX_PAPLAY_SOUND] };
    }
    return null;
  }
  return null;
}

export function commandExists(command: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (dir === '') {
      continue;
    }
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

export interface SoundProcess {
  on(event: string, listener: () => void): unknown;
  unref(): unknown;
}

export type SoundSpawner = (command: string, args: readonly string[]) => SoundProcess;

function spawnDetachedSound(command: string, args: readonly string[]): SoundProcess {
  return spawn(command, [...args], { stdio: 'ignore', detached: true });
}

export function playSoundSpec(spec: SoundSpec, spawnFn: SoundSpawner = spawnDetachedSound): void {
  try {
    const child = spawnFn(spec.command, spec.args);
    child.on('error', () => {
      // Best-effort: ignore asynchronous player failures.
    });
    child.unref();
  } catch {
    // Best-effort: sound playback never fails the review cycle.
  }
}

export interface AudioDeps {
  write?: BellWriter;
  spawnSound?: SoundSpawner;
  platform?: string;
  exists?: FileExists;
  canRun?: CommandAvailable;
}

export function ringTerminalNotification(policy: BellPolicy, deps: AudioDeps = {}): void {
  if (!shouldRingBell(policy)) {
    return;
  }
  const write =
    deps.write ??
    ((output: string) => {
      process.stdout.write(output);
    });
  write(TERMINAL_BELL);
  const spec = selectSoundSpec(
    deps.platform ?? process.platform,
    deps.exists ?? fs.existsSync,
    deps.canRun ?? commandExists,
  );
  if (spec !== null) {
    playSoundSpec(spec, deps.spawnSound);
  }
}
