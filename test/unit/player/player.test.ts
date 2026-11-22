import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replayTrace } from '../../../src/core/trace/index.js';
import { TracePlayer } from '../../../src/player/index.js';
import { loadTrace } from '../../helpers/replay-driver.js';

/** The screen a fresh replay shows after host record `frame`. */
const screenAt = (name: string, frame: number) => replayTrace(loadTrace(name)).screens[frame]!.text;

describe('TracePlayer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('plays a recording to the end, at its pace, and ends on the final screen', () => {
    const trace = loadTrace('tk5/tso-logon');
    const player = new TracePlayer(trace, { idleLimit: 1 });
    const frames: number[] = [];
    const end = vi.fn();
    player.on('frame', (f) => frames.push(f.frame));
    player.on('end', end);
    expect(player.frames).toBe(20);
    player.play();
    vi.advanceTimersByTime(player.duration * 1000 + 100);
    expect(end).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([...Array(player.frames).keys()]);
    expect(player.terminal.text).toEqual(replayTrace(trace).final.text);
    expect(player.playing).toBe(false);
  });

  it('pauses, resumes and plays faster', () => {
    const player = new TracePlayer(loadTrace('tk5/ispf-tour'), { idleLimit: 1 });
    player.play();
    vi.advanceTimersByTime(1000);
    player.pause();
    const at = player.frame;
    vi.advanceTimersByTime(5000);
    expect(player.frame).toBe(at); // paused: nothing more
    player.speed = 10;
    player.play();
    vi.advanceTimersByTime(((player.duration - player.time) * 1000) / 10 + 50);
    expect(player.frame).toBe(player.frames - 1);
  });

  it('seeks to a frame, back and forward, showing that frame’s screen', () => {
    const name = 'tk5/ispf-tour';
    const views: unknown[] = [];
    const player = new TracePlayer(loadTrace(name), { view: { attach: (t) => views.push(t) } });
    player.seekFrame(15); // RFE DSLIST
    expect(player.terminal.text).toEqual(screenAt(name, 15));
    player.seekFrame(4); // back: the password prompt
    expect(player.terminal.text).toEqual(screenAt(name, 4));
    player.seekFrame(22);
    expect(player.terminal.text).toEqual(screenAt(name, 22));
    expect(views.at(-1)).toBe(player.terminal); // the view follows the new terminal
    player.seek(0);
    expect(player.frame).toBe(-1);
  });

  it('caps long pauses at the idle limit', () => {
    const trace = loadTrace('tk5/tso-logon');
    const real = trace.events.at(-1)!.t / 1000;
    expect(new TracePlayer(trace, { idleLimit: 0.5 }).duration).toBeLessThanOrEqual(real);
    expect(new TracePlayer(trace, { idleLimit: 0.5 }).duration).toBeLessThan(
      new TracePlayer(trace, { idleLimit: 100 }).duration + 1e-9,
    );
  });

  it('rejects something that is not a trace', () => {
    expect(() => new TracePlayer({ format: 'x' } as never)).toThrow(/not a 3270js trace/);
  });
});
