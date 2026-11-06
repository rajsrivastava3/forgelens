import { describe, expect, it, vi } from 'vitest';
import { IMPLEMENT_MESSAGE, parsePlan, PLAN_READ_LIMIT, PLAN_RULE } from '../../src/core/context/plan';
import { AgentController, type SendOptions } from '../../src/core/trueforge/agentController';
import type { PlanItem } from '../../src/core/trueforge/runView';
import type { SessionsApi, TurnEvent } from '../../src/core/trueforge/turnRunner';

const PRIMARY = 'google-gemini/gemini-3-8-flash';
const FALLBACK = 'google-gemini/gemini-3-6-flash';

const PLAN_TEXT = [
  'I checked the pack. Here is what I will do.',
  '',
  '**Plan:**',
  '- `src/pkg/cli.py`: add `export_command` after `routes_command` (line 1069) and register it in `FlaskGroup.__init__` (line 596). Why: built-in commands live and are registered here.',
  '- tests/test_cli.py (new test): add `test_export_command` near the routes tests. Why: the command needs a test.',
  '  It checks the masked keys too.',
  '1. docs/cli.rst: add a "Show the Configuration" section after "Open a Shell" (line 133). Why: built-in commands are documented here.',
  '- CHANGES.rst: add an entry under Unreleased.',
  '  Why: user-facing changes are recorded.',
].join('\n');

describe('parsePlan', () => {
  it('reads each file, what changes in it and why, in the forms models write', () => {
    expect(parsePlan(PLAN_TEXT)).toEqual([
      {
        path: 'src/pkg/cli.py',
        what: 'add `export_command` after `routes_command` (line 1069) and register it in `FlaskGroup.__init__` (line 596)',
        why: 'built-in commands live and are registered here.',
      },
      { path: 'tests/test_cli.py', what: 'add `test_export_command` near the routes tests', why: 'the command needs a test. It checks the masked keys too.' },
      { path: 'docs/cli.rst', what: 'add a "Show the Configuration" section after "Open a Shell" (line 133)', why: 'built-in commands are documented here.' },
      { path: 'CHANGES.rst', what: 'add an entry under Unreleased', why: 'user-facing changes are recorded.' },
    ]);
  });

  it('accepts "Plan:" with the first step on the same heading, a markdown heading, and numbered steps', () => {
    expect(parsePlan('## Plan\n1. a/b.py: change f. Why: it is wrong.')?.[0]).toEqual({ path: 'a/b.py', what: 'change f', why: 'it is wrong.' });
    expect(parsePlan('Plan:\n- README.md: note it')?.[0]).toEqual({ path: 'README.md', what: 'note it', why: '' });
  });

  it('gives nothing for an answer to a question, or a plan with no file', () => {
    expect(parsePlan('get_debug_flag is defined in src/flask/helpers.py at line 27.')).toBeUndefined();
    expect(parsePlan('Plan:\n- think about it first')).toBeUndefined();
    expect(parsePlan('')).toBeUndefined();
  });

  it('asks for the plan form the parser reads, and caps reads before the plan', () => {
    expect(PLAN_RULE).toContain('start with the line "Plan:"');
    expect(PLAN_RULE).toContain('- <path>: <the exact functions or lines you will change or add>. Why: <one line>');
    expect(PLAN_RULE).toContain('call create_sub_agent once to start an explorer');
    expect(PLAN_RULE).toContain('use at most 3 tool calls');
    expect(PLAN_READ_LIMIT).toBe(3);
    expect(IMPLEMENT_MESSAGE).toBe(
      'Implement your plan now. Stage all edits with as few stage_edit calls as possible, run the tests once with run_command target=staged, fix only what fails, then call apply_changes once.',
    );
  });
});

type Turn = { text: string } | { error: string };

/** Answers each turn in order, whatever the session. Records which session and what text each turn got. */
function server(turns: Turn[]) {
  const sent: { sessionId: string; model: string; text: string }[] = [];
  const sessionModel = new Map<string, string>();
  let counter = 0;
  const createSession = vi.fn((_agent: string, model: string) => {
    counter += 1;
    sessionModel.set(`s${counter}`, model);
    return Promise.resolve(`s${counter}`);
  });
  const sessions: SessionsApi = {
    createTurnStream: (sessionId, request) => {
      const first = request.input[0];
      sent.push({ sessionId, model: sessionModel.get(sessionId) ?? '?', text: first?.type === 'user.message' ? String(first.content) : '' });
      const turn = turns.shift() ?? { text: 'done' };
      return Promise.resolve({
        withMetadata: () =>
          (async function* () {
            if ('error' in turn) {
              yield { data: { type: 'turn.done', id: 'd', state: { status: 'error', message: turn.error } } as unknown as TurnEvent, id: '1' };
              return;
            }
            const message = { type: 'model.message', id: `m${sent.length}`, threadId: 'main', content: turn.text, toolCalls: [], createdAt: '2026-11-07T00:00:00Z' } as unknown as TurnEvent;
            yield { data: message, id: '1' };
            yield { data: { type: 'turn.done', id: 'd', state: { status: 'done', output: message } } as unknown as TurnEvent, id: '2' };
          })(),
      });
    },
    cancel: () => Promise.resolve(),
  };
  return { sessions, createSession, sent };
}

function build(turns: Turn[]) {
  const tf = server(turns);
  const onTurnStart = vi.fn();
  const controller = new AgentController({
    baseUrl: () => 'http://tf.test',
    agentName: 'forgelens-agent',
    sessions: () => tf.sessions,
    createSession: tf.createSession,
    ensureReady: () => Promise.resolve(PRIMARY),
    models: () => [PRIMARY, FALLBACK],
    onChange: () => undefined,
    onTurnStart,
    retryDelaysMs: [],
    sleep: () => Promise.resolve(),
  });
  return { controller, tf, onTurnStart };
}

/** The same follow-up sendAgentRequest gives the controller. */
const planThenImplement: SendOptions = {
  prepare: (message) => Promise.resolve({ prompt: `PACK\n\n## Request\n${message}\n\n${PLAN_RULE}` }),
  firstTurnReadLimit: PLAN_READ_LIMIT,
  followUp: (output) => {
    const plan = parsePlan(output);
    return plan ? { prompt: IMPLEMENT_MESSAGE, plan } : undefined;
  },
};

describe('plan, then implement', () => {
  it('shows the plan and sends the implement turn in the same session', async () => {
    const { controller, tf, onTurnStart } = build([{ text: PLAN_TEXT }, { text: 'Applied 4 of 4 hunks.' }]);
    await controller.send('add a config command', planThenImplement);
    expect(tf.sent.map((turn) => turn.sessionId)).toEqual(['s1', 's1']);
    expect(tf.sent[0]?.text).toContain('## How to answer');
    expect(tf.sent[1]?.text).toBe(IMPLEMENT_MESSAGE);
    const plan = controller.view.items.find((item): item is PlanItem => item.kind === 'plan');
    expect(plan?.steps.map((step) => step.path)).toEqual(['src/pkg/cli.py', 'tests/test_cli.py', 'docs/cli.rst', 'CHANGES.rst']);
    expect(controller.view.status).toBe('done');
    // Each turn starts the read count again: 3 for the plan turn, the usual limit after.
    expect(onTurnStart.mock.calls).toEqual([[3], [undefined]]);
  });

  it('sends nothing more after an answer to a question', async () => {
    const { controller, tf } = build([{ text: 'It is defined in src/pkg/helpers.py at line 27.' }]);
    await controller.send('where is get_debug_flag defined', planThenImplement);
    expect(tf.sent).toHaveLength(1);
    expect(controller.view.items.some((item) => item.kind === 'plan')).toBe(false);
  });

  it('when the implement turn fails over to the fallback, the new session gets the request, the plan and the step', async () => {
    const { controller, tf } = build([{ text: PLAN_TEXT }, { error: '[Model Error] Request failed (401): Unauthorized.' }, { text: 'Applied.' }]);
    await controller.send('add a config command', planThenImplement);
    expect(tf.sent.map((turn) => `${turn.sessionId}:${turn.model}`)).toEqual([`s1:${PRIMARY}`, `s1:${PRIMARY}`, `s2:${FALLBACK}`]);
    const replay = tf.sent[2]?.text ?? '';
    expect(replay).toContain('## Request\nadd a config command');
    expect(replay).toContain('## Your plan, from the turn before\nI checked the pack.');
    expect(replay.endsWith(IMPLEMENT_MESSAGE)).toBe(true);
    expect(controller.view.items.filter((item) => item.kind === 'plan')).toHaveLength(1);
  });

  it('Stop after the plan sends no implement turn', async () => {
    const { controller, tf } = build([{ text: PLAN_TEXT }]);
    const options: SendOptions = {
      ...planThenImplement,
      followUp: (output) => {
        void controller.stop();
        return planThenImplement.followUp?.(output);
      },
    };
    await controller.send('add a config command', options);
    expect(tf.sent).toHaveLength(1);
  });
});
