import { describe, expect, it, vi } from 'vitest';
import { AgentController } from '../../src/core/trueforge/agentController';
import { describeTurnError, failureAction, shortReason } from '../../src/core/trueforge/errors';
import type { NoticeItem } from '../../src/core/trueforge/runView';
import type { SessionsApi, TurnEvent, TurnStream } from '../../src/core/trueforge/turnRunner';

const PRIMARY = 'google-gemini/gemini-3-8-flash';
const FALLBACK = 'gemini-free/gemini-flash-lite-latest';

type Behaviour = 'ok' | 'hang' | { error: string } | { throws: string };

function done(state: unknown): TurnEvent {
  return { type: 'turn.done', id: `done-${Math.random()}`, state } as unknown as TurnEvent;
}

function answer(text: string): TurnEvent {
  return { type: 'model.message', id: `m-${Math.random()}`, threadId: 'main', content: text, toolCalls: [], createdAt: '2026-11-06T00:00:00Z' } as unknown as TurnEvent;
}

/** Each model fails or answers as told, once per attempt. Sessions remember which model they were made for. */
function scripted(plan: Record<string, Behaviour[]>) {
  const sessionModel = new Map<string, string>();
  const attempts: string[] = [];
  const prompts: string[] = [];
  let cancels = 0;
  let cancelHang: (() => void) | undefined;
  let counter = 0;
  const createSession = vi.fn((_agent: string, model: string) => {
    counter += 1;
    const id = `s${counter}`;
    sessionModel.set(id, model);
    return Promise.resolve(id);
  });
  const sessions: SessionsApi = {
    createTurnStream: (sessionId, request) => {
      const model = sessionModel.get(sessionId) ?? '?';
      attempts.push(model);
      const first = request.input[0];
      if (first?.type === 'user.message') prompts.push(String(first.content));
      const behaviour = plan[model]?.shift() ?? 'ok';
      if (typeof behaviour === 'object' && 'throws' in behaviour) return Promise.reject(new Error(behaviour.throws));
      const stream: TurnStream = {
        withMetadata: () =>
          (async function* () {
            if (behaviour === 'hang') {
              await new Promise<void>((resolve) => {
                cancelHang = resolve;
              });
              yield { data: done({ status: 'cancelled', reason: 'client-cancelled' }), id: '1' };
              return;
            }
            if (behaviour === 'ok') {
              const text = answer(`answered by ${model}`);
              yield { data: text, id: '1' };
              yield { data: done({ status: 'done', output: text }), id: '2' };
              return;
            }
            yield { data: done({ status: 'error', message: behaviour.error }), id: '1' };
          })(),
      };
      return Promise.resolve(stream);
    },
    cancel: () => {
      cancels += 1;
      cancelHang?.();
      return Promise.resolve();
    },
  };
  return { sessions, createSession, attempts, prompts, cancels: () => cancels };
}

function build(plan: Record<string, Behaviour[]>, extra: Partial<ConstructorParameters<typeof AgentController>[0]> = {}) {
  const server = scripted(plan);
  const discard = vi.fn();
  const waits: number[] = [];
  const controller = new AgentController({
    baseUrl: () => 'http://tf.test',
    agentName: 'forgelens-agent',
    sessions: () => server.sessions,
    createSession: server.createSession,
    ensureReady: () => Promise.resolve(PRIMARY),
    models: () => [PRIMARY, FALLBACK],
    onChange: () => undefined,
    discardStaged: discard,
    retryDelaysMs: [1_000, 3_000],
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    ...extra,
  });
  return { controller, server, discard, waits };
}

const notices = (controller: AgentController): NoticeItem[] => controller.view.items.filter((item): item is NoticeItem => item.kind === 'notice');
const err = (status: number, text: string): Behaviour => ({ error: `[Model Error] Request failed (${status}): ${text}` });

describe('failure classification', () => {
  it.each([
    [402, 'Your prepayment credits are depleted.', 'billing', 'fallback'],
    [401, 'Unauthorized.', 'auth', 'fallback'],
    [403, 'Permission denied.', 'auth', 'fallback'],
    [400, 'API key not valid. Please pass a valid API key.', 'auth', 'fallback'],
    [404, 'models/x is not found.', 'model-not-found', 'fallback'],
    [400, 'Bad Request', 'bad-request', 'fallback'],
    [429, 'You exceeded your current quota.', 'quota', 'retry'],
    [503, 'The model is overloaded.', 'overloaded', 'retry'],
  ])('%i %s is %s and means %s', (status, text, kind, action) => {
    const error = describeTurnError(`[Model Error] Request failed (${status}): ${text}`);
    expect(error.kind).toBe(kind);
    expect(failureAction(error)).toBe(action);
  });

  it('tells a provider that cannot be reached from TrueForge being down', () => {
    const provider = describeTurnError('[Model Error] fetch failed: connect ECONNREFUSED 127.0.0.1:9');
    expect(provider.kind).toBe('network');
    expect(failureAction(provider)).toBe('retry');
    // As TrueForge reports a provider endpoint that refuses connections (seen in P5).
    expect(describeTurnError('Cannot connect to API: connect ECONNREFUSED 127.0.0.1:59999').kind).toBe('network');
    const harness = describeTurnError('fetch failed: connect ECONNREFUSED 127.0.0.1:8790', 'http://localhost:8790');
    expect(harness.kind).toBe('unreachable');
    expect(failureAction(harness)).toBe('stop');
    expect(harness.message).toContain('TrueForge is not running at http://localhost:8790');
  });

  it('does not switch models when the agent itself failed', () => {
    expect(failureAction(describeTurnError('You have reached iteration limit of 15, please request again'))).toBe('stop');
  });

  it('gives a short reason for the banner', () => {
    expect(shortReason(describeTurnError('[Model Error] Request failed (401): Unauthorized.'))).toBe('invalid API key (401)');
  });
});

describe('ModelChain in the controller', () => {
  it('402 on the primary falls back at once, with no retry, and says so', async () => {
    const { controller, server, discard, waits } = build({ [PRIMARY]: [err(402, 'Your prepayment credits are depleted.')] });
    await controller.send('go');
    expect(server.attempts).toEqual([PRIMARY, FALLBACK]);
    expect(waits).toEqual([]);
    expect(controller.view.status).toBe('done');
    expect(controller.activeModel).toBe(FALLBACK);
    expect(controller.view.model).toBe(FALLBACK);
    expect(notices(controller)[0]).toMatchObject({ tone: 'warning', text: `Primary model failed: billing refused the request (402). Switched to ${FALLBACK} automatically.` });
    expect(discard).toHaveBeenCalled();
    expect(server.createSession.mock.calls.map((call) => call[1])).toEqual([PRIMARY, FALLBACK]);
  });

  it('401 falls back at once', async () => {
    const { controller, server, waits } = build({ [PRIMARY]: [err(401, 'Unauthorized.')] });
    await controller.send('go');
    expect(server.attempts).toEqual([PRIMARY, FALLBACK]);
    expect(waits).toEqual([]);
    expect(notices(controller)[0]?.text).toContain('invalid API key (401)');
  });

  it('429 retries the same model twice with growing, jittered waits, then falls back', async () => {
    const quota = err(429, 'You exceeded your current quota.');
    const { controller, server, waits } = build({ [PRIMARY]: [quota, quota, quota] });
    await controller.send('go');
    expect(server.attempts).toEqual([PRIMARY, PRIMARY, PRIMARY, FALLBACK]);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(800);
    expect(waits[0]).toBeLessThanOrEqual(1_200);
    expect(waits[1]).toBeGreaterThanOrEqual(2_400);
    expect(waits[1]).toBeLessThanOrEqual(3_600);
    expect(notices(controller).map((notice) => notice.tone)).toEqual(['info', 'info', 'warning']);
    expect(controller.view.status).toBe('done');
  });

  it('a 429 that clears on retry stays on the primary', async () => {
    const { controller, server } = build({ [PRIMARY]: [err(429, 'Slow down.')] });
    await controller.send('go');
    expect(server.attempts).toEqual([PRIMARY, PRIMARY]);
    expect(controller.activeModel).toBe(PRIMARY);
  });

  it('a silent model times out before its first token, is cancelled, retried, then replaced', async () => {
    const { controller, server } = build({ [PRIMARY]: ['hang', 'hang', 'hang'] }, { firstTokenMs: 20 });
    await controller.send('go');
    expect(server.attempts).toEqual([PRIMARY, PRIMARY, PRIMARY, FALLBACK]);
    expect(server.cancels()).toBe(3);
    expect(notices(controller).at(-1)?.text).toContain('Primary model failed: no response in time');
    expect(controller.view.status).toBe('done');
  });

  it('the timeout does not apply once the model has started answering', async () => {
    const { controller, server } = build({}, { firstTokenMs: 5 });
    await controller.send('go');
    expect(server.attempts).toEqual([PRIMARY]);
    expect(server.cancels()).toBe(0);
  });

  it('TrueForge down gives one clear message and tries no other model', async () => {
    const { controller, server } = build({ [PRIMARY]: [{ throws: 'fetch failed: connect ECONNREFUSED 127.0.0.1:8790' }] });
    await controller.send('go');
    expect(server.attempts).toEqual([PRIMARY]);
    expect(controller.view.status).toBe('error');
    expect(controller.view.error).toBe('TrueForge is not running at http://tf.test. Start it with scripts/start-trueforge.ps1 (or .sh), then run "ForgeLens: Set up TrueForge".');
    expect(controller.view.error).not.toMatch(/\n\s+at /);
  });

  it('when every model fails, one clear message and a way to switch models', async () => {
    const { controller, server } = build({ [PRIMARY]: [err(401, 'Unauthorized.')], [FALLBACK]: [err(400, 'Bad Request')] });
    await controller.send('go');
    expect(server.attempts).toEqual([PRIMARY, FALLBACK]);
    expect(controller.view.status).toBe('error');
    expect(controller.view.error).toContain('Every configured model failed');
    expect(controller.view.errorAction).toBe('switch-model');
    expect(controller.view.statusText).toBe('Failed, workspace unchanged');
  });

  it('an agent failure is not a model failure, so there is no switch', async () => {
    const { controller, server } = build({ [PRIMARY]: [{ error: 'You have reached iteration limit of 15, please request again' }] });
    await controller.send('go');
    expect(server.attempts).toEqual([PRIMARY]);
    expect(controller.view.error).toContain('iteration limit');
  });

  it('the fallback gets the same prompt, Context Pack included, in a fresh session', async () => {
    const { controller, server } = build({ [PRIMARY]: [err(402, 'No credit.')] });
    await controller.send('short', { prepare: (message) => Promise.resolve({ prompt: `PACK\n${message}` }) });
    expect(server.prompts).toEqual(['PACK\nshort', 'PACK\nshort']);
    expect(new Set(server.createSession.mock.calls.map((call) => call[1])).size).toBe(2);
  });

  it('Stop during a retry wait ends the request, with nothing more sent', async () => {
    let releaseWait: () => void = () => undefined;
    const { controller, server } = build(
      { [PRIMARY]: [err(503, 'Overloaded.')] },
      {
        sleep: () =>
          new Promise<void>((resolve) => {
            releaseWait = resolve;
          }),
      },
    );
    const sending = controller.send('go');
    await vi.waitFor(() => expect(controller.view.statusText).toContain('Trying again'));
    await controller.stop();
    releaseWait();
    await sending;
    expect(server.attempts).toEqual([PRIMARY]);
    expect(controller.view.status).toBe('cancelled');
  });

  it('with one model configured, a failure is just reported', async () => {
    const { controller, server } = build({ [PRIMARY]: [err(401, 'Unauthorized.')] }, { models: () => [PRIMARY] });
    await controller.send('go');
    expect(server.attempts).toEqual([PRIMARY]);
    expect(controller.view.error).toContain('rejected the API key');
    expect(controller.view.error).not.toContain('Every configured model');
  });
});
