/**
 * A scripted server for dry runs, so the rehearsal scripts' checks can be proven with no model. Each step plays
 * what TrueForge would send, in the shape of the recorded sessions, and real tool calls go to the real MCP server.
 */
import type { SessionsApi, TurnInput } from '../../src/core/trueforge/turnRunner';

export type ScriptStep =
  | { kind: 'tool'; name: string; args: unknown }
  /** A gated call: the turn pauses until the approval comes back. */
  | { kind: 'gated'; name: string; args: unknown }
  | { kind: 'thread'; title: string; tools: { name: string; args: unknown }[]; answer: string }
  | { kind: 'text'; text: string }
  /** Any other event TrueForge sends, as given. */
  | { kind: 'event'; event: unknown }
  /** Runs something between events, for a test that wants to look at the screen. */
  | { kind: 'hook'; run: () => Promise<void> };

export function scriptedSessions(steps: readonly ScriptStep[], callTool: (name: string, args: unknown) => Promise<string>): SessionsApi {
  let next = 0;
  let counter = 0;
  let waiting: { id: string; name: string; args: unknown } | undefined;
  const id = (name: string): string => {
    counter += 1;
    return `${name}-${counter}`;
  };
  const stamp = (): string => new Date().toISOString();
  const call = (callId: string, name: string, args: unknown): unknown => ({
    id: callId,
    type: 'function',
    toolInfo: { type: 'mcp', name, serverName: 'forgelens-editor' },
    function: { name, arguments: JSON.stringify(args) },
  });
  const message = (threadId: string, content: string, toolCalls: unknown[] = []): { type: string; id: string; threadId: string; createdAt: string; content: string; toolCalls: unknown[] } => ({
    type: 'model.message',
    id: id('message'),
    threadId,
    createdAt: stamp(),
    content,
    toolCalls,
  });
  const response = (threadId: string, toolCallId: string, content: string): unknown => ({ type: 'tool.response', id: id('response'), threadId, createdAt: stamp(), toolCallId, content });
  const done = (state: unknown): unknown => ({ type: 'turn.done', id: id('done'), createdAt: stamp(), state });

  const run = async function* (input: readonly TurnInput[]): AsyncGenerator<{ data: unknown; id: string }> {
    let sequence = 0;
    const emit = (data: unknown): { data: unknown; id: string } => {
      sequence += 1;
      return { data, id: String(sequence) };
    };
    const decision = input[0];
    if (decision?.type === 'user.tool_approval' && waiting) {
      const pending = waiting;
      waiting = undefined;
      const allowed = decision.approval.status === 'allow';
      yield emit(response('main', pending.id, allowed ? await callTool(pending.name, pending.args) : JSON.stringify({ error: 'User denied tool call.' })));
    }
    while (next < steps.length) {
      const step = steps[next] as ScriptStep;
      next += 1;
      if (step.kind === 'event') {
        yield emit(step.event);
      } else if (step.kind === 'hook') {
        await step.run();
      } else if (step.kind === 'tool') {
        const callId = id('call');
        yield emit(message('main', '', [call(callId, step.name, step.args)]));
        yield emit(response('main', callId, await callTool(step.name, step.args)));
      } else if (step.kind === 'gated') {
        const callId = id('call');
        const source = message('main', '', [call(callId, step.name, step.args)]);
        yield emit(source);
        waiting = { id: callId, name: step.name, args: step.args };
        yield emit({ type: 'tool.approval_required', id: id('approval'), threadId: 'main', createdAt: stamp(), toolCalls: [{ id: callId, sourceEventId: source.id }] });
        yield emit(done({ status: 'done', output: null, requiredActions: [] }));
        return;
      } else if (step.kind === 'thread') {
        const spawnId = id('call');
        const threadId = id('thread');
        yield emit(message('main', '', [{ id: spawnId, type: 'function', toolInfo: { type: 'truefoundry-system', name: 'create_sub_agent' }, function: { name: 'create_sub_agent', arguments: '{}' } }]));
        yield emit({ type: 'thread.created', id: id('created'), threadId, createdAt: stamp(), title: step.title, parent: { threadId: 'main', toolCallId: spawnId } });
        for (const tool of step.tools) {
          const callId = id('call');
          yield emit(message(threadId, '', [call(callId, tool.name, tool.args)]));
          yield emit(response(threadId, callId, await callTool(tool.name, tool.args)));
        }
        yield emit(message(threadId, step.answer));
        yield emit({ type: 'thread.done', id: id('thread-done'), threadId, createdAt: stamp() });
        yield emit(response('main', spawnId, step.answer));
      } else {
        const final = message('main', step.text);
        yield emit(final);
        yield emit(done({ status: 'done', output: final, requiredActions: [] }));
        return;
      }
    }
    yield emit(done({ status: 'done', output: null, requiredActions: [] }));
  };

  return {
    createTurnStream: (_session, request) => Promise.resolve({ withMetadata: () => run(request.input) as never }),
    cancel: () => Promise.resolve(),
  };
}
