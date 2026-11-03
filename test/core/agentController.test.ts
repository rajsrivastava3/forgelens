import { describe, expect, it, vi } from 'vitest';
import { AgentController } from '../../src/core/trueforge/agentController';
import type { SessionsApi } from '../../src/core/trueforge/turnRunner';
import { loadRecording, replaySessions } from './helpers/fixtures';

function controller(sessions: SessionsApi, overrides: Partial<ConstructorParameters<typeof AgentController>[0]> = {}) {
  const onChange = vi.fn();
  const createSession = vi.fn(() => Promise.resolve('sess-1'));
  const instance = new AgentController({
    baseUrl: () => 'http://tf.test',
    agentName: 'forgelens-agent',
    sessions: () => sessions,
    createSession,
    ensureReady: () => Promise.resolve('p/m'),
    onChange,
    ...overrides,
  });
  return { instance, onChange, createSession };
}

describe('AgentController', () => {
  it('runs a recorded request and exposes the session link and model', async () => {
    const { turns } = loadRecording('subagent-read');
    const { instance } = controller(replaySessions(turns));
    await instance.send('where is it?');
    expect(instance.view.status).toBe('done');
    expect(instance.view.model).toBe('p/m');
    expect(instance.view.sessionUrl).toBe('http://tf.test/sessions/sess-1');
    expect(instance.isBusy).toBe(false);
  });

  it('reuses the session for follow-ups, and starts a new one after the model changes or New chat', async () => {
    const { turns } = loadRecording('subagent-read');
    let model = 'p/m';
    const { instance, createSession } = controller(replaySessions([...turns, ...turns, ...turns, ...turns]), {
      ensureReady: () => Promise.resolve(model),
    });
    await instance.send('one');
    await instance.send('two');
    expect(createSession).toHaveBeenCalledTimes(1);
    model = 'q/n';
    await instance.send('three');
    expect(createSession).toHaveBeenCalledTimes(2);
    instance.newChat();
    expect(instance.view.items).toEqual([]);
    await instance.send('four');
    expect(createSession).toHaveBeenCalledTimes(3);
  });

  it('routes the panel decision to the waiting approval', async () => {
    const { turns } = loadRecording('preloaded-allow');
    const sessions = replaySessions(turns);
    const { instance, onChange } = controller(sessions);
    const sending = instance.send('go');
    await vi.waitFor(() => expect(instance.view.status).toBe('awaiting-approval'));
    expect(onChange).toHaveBeenCalled();
    const toolId = instance.view.items.find((item) => item.kind === 'tool')?.id ?? '';
    instance.decide(toolId, true);
    await sending;
    expect(instance.view.status).toBe('done');
    expect(sessions.inputs[1]?.[0]).toMatchObject({ approval: { status: 'allow' } });
  });

  it('ignores a send while busy and a blank message', async () => {
    const { turns } = loadRecording('preloaded-allow');
    const sessions = replaySessions(turns);
    const { instance } = controller(sessions);
    await instance.send('   ');
    expect(sessions.inputs).toHaveLength(0);
    const sending = instance.send('go');
    await instance.send('second');
    await vi.waitFor(() => expect(instance.view.status).toBe('awaiting-approval'));
    expect(instance.view.items.filter((item) => item.kind === 'user')).toHaveLength(1);
    instance.stop();
    await sending;
  });

  it('shows a clear message when setup fails, and never rejects', async () => {
    const message = 'TrueForge is not running at http://tf.test. Start it with scripts/start-trueforge.ps1.';
    const { instance, createSession } = controller(replaySessions([]), {
      ensureReady: () => Promise.reject(new Error(message)),
    });
    await instance.send('hello');
    expect(instance.view.status).toBe('error');
    expect(instance.view.error).toBe(message);
    expect(createSession).not.toHaveBeenCalled();
    expect(instance.isBusy).toBe(false);
  });

  it('honours a stop pressed before the session is ready, sending nothing', async () => {
    let release: (value: string) => void = () => undefined;
    const sessions = replaySessions([]);
    const { instance } = controller(sessions, {
      ensureReady: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const sending = instance.send('go');
    instance.stop();
    expect(instance.view.statusText).toBe('Stopping…');
    release('p/m');
    await sending;
    expect(instance.view.status).toBe('cancelled');
    expect(sessions.inputs).toHaveLength(0);
  });
});
