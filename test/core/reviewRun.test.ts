import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewFlow } from '../../src/core/changeset/reviewFlow';
import { NodeEditorPort } from '../../src/core/tools/nodeEditorPort';
import { stageEditTool } from '../../src/core/tools/stageTools';
import { AgentController } from '../../src/core/trueforge/agentController';
import { RunViewBuilder, type ReviewItem, type ToolItem, type ViewItem } from '../../src/core/trueforge/runView';
import type { SessionsApi, TurnEvent } from '../../src/core/trueforge/turnRunner';
import { loadRecording, replaySessions, type ReplayApi } from './helpers/fixtures';

const numbered = (count: number): string => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

/** Real recorded events, with the probe's name swapped for the tool it stood in for. */
function recordedApply(name: 'via-call-tool-allow' | 'preloaded-allow' | 'subagent-allow'): TurnEvent[][] {
  const { turns } = loadRecording(name);
  return JSON.parse(JSON.stringify(turns).replaceAll('apply_changes_probe', 'apply_changes')) as TurnEvent[][];
}

const reviewCards = (items: readonly ViewItem[]): ReviewItem[] => items.filter((item): item is ReviewItem => item.kind === 'review');
const tools = (items: readonly ViewItem[]): ToolItem[] =>
  items.flatMap((item) => (item.kind === 'tool' ? [item] : item.kind === 'thread' ? tools(item.items) : []));

describe('apply_changes approval drives the review (recorded events, no model)', () => {
  let dir: string;
  let flow: ReviewFlow;
  let controller: AgentController;
  let sessions: ReplayApi;
  let toolResults: string[];

  const onDisk = (file: string): string => readFileSync(path.join(dir, file), 'utf8');

  const setUp = (turns: TurnEvent[][]): void => {
    sessions = replaySessions(turns);
    const replay = sessions;
    // Stands in for TrueForge: an allowed call reaches the tool when the resumed turn starts.
    const server: SessionsApi = {
      createTurnStream: async (id, request, options) => {
        const allowed = request.input.some((item) => item.type === 'user.tool_approval' && item.approval.status === 'allow');
        if (allowed && flow.isApprovedChangeWaiting) {
          toolResults.push(await flow.applyApproved('from the recording'));
        }
        return replay.createTurnStream(id, request, options);
      },
      cancel: (id) => replay.cancel(id),
    };
    controller = new AgentController({
      baseUrl: () => 'http://tf.test',
      agentName: 'forgelens-agent',
      sessions: () => server,
      createSession: () => Promise.resolve(`sess-${String(sessionCounter.next())}`),
      ensureReady: () => Promise.resolve('p/m'),
      onChange: () => undefined,
      reviewApproval: (approval, signal) => (approval.call.name === 'apply_changes' ? flow.requestReview(approval, signal) : undefined),
      discardStaged: () => flow.discard(),
    });
    flow = new ReviewFlow(new NodeEditorPort(dir), { onCard: (card) => controller.updateReview(card) });
  };

  const sessionCounter = {
    value: 0,
    next(): number {
      this.value += 1;
      return this.value;
    },
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'forgelens run '));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src/a.py'), numbered(40));
    writeFileSync(path.join(dir, 'src/b.py'), numbered(40));
    toolResults = [];
    sessionCounter.value = 0;
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const stageBoth = async (): Promise<void> => {
    await stageEditTool(flow.changeset, dir, { path: 'src/a.py', edits: [{ old_text: 'line 5\n', new_text: 'five\n' }] });
    await stageEditTool(flow.changeset, dir, { path: 'src/b.py', edits: [{ old_text: 'line 9\n', new_text: 'nine\n' }] });
  };

  it.each(['via-call-tool-allow', 'preloaded-allow', 'subagent-allow'] as const)(
    'opens the review on the %s path, then applies only what was accepted',
    async (recording) => {
      setUp(recordedApply(recording));
      await stageBoth();
      const sending = controller.send('change it');
      await vi.waitFor(() => expect(flow.isReviewing).toBe(true));

      expect(reviewCards(controller.view.items)[0]).toMatchObject({ phase: 'reviewing', text: '2 files, 2 hunks, waiting for your review' });
      expect(controller.view.statusText).toBe('Waiting for your review');
      expect(tools(controller.view.items).find((tool) => tool.name === 'apply_changes')?.status).toBe('awaiting-approval');
      expect(onDisk('src/a.py')).toBe(numbered(40));

      const [first, second] = flow.changeset.hunks;
      flow.setDecision(first?.id as string, 'accepted');
      flow.setDecision(second?.id as string, 'rejected');
      await flow.applyDecisions();
      await sending;

      expect(onDisk('src/a.py')).toContain('five');
      expect(onDisk('src/b.py')).toBe(numbered(40));
      expect(sessions.inputs[1]?.[0]).toMatchObject({ approval: { status: 'allow' } });
      expect(toolResults[0]).toContain('1 of 2 hunks');
      expect(reviewCards(controller.view.items)[0]).toMatchObject({ phase: 'applied', text: 'Applied 1/2 hunks in 1 file', canUndo: true });
      expect(controller.view.status).toBe('done');
    },
  );

  it('sends deny with the hunk ids when everything is rejected, and writes nothing', async () => {
    const [firstTurn] = recordedApply('via-call-tool-allow');
    setUp([firstTurn ?? [], recordedApply('via-call-tool-allow')[1] ?? []]);
    await stageBoth();
    const ids = flow.changeset.hunks.map((hunk) => hunk.id);
    const sending = controller.send('change it');
    await vi.waitFor(() => expect(flow.isReviewing).toBe(true));
    flow.setAll('rejected');
    await flow.applyDecisions();
    await sending;
    expect(sessions.inputs[1]?.[0]).toMatchObject({
      type: 'user.tool_approval',
      approval: { status: 'deny', reason: `user rejected all hunks: ${ids.join(', ')}` },
    });
    expect(toolResults).toEqual([]);
    expect(onDisk('src/a.py')).toBe(numbered(40));
  });

  it('Stop during review discards, closes the review and leaves the workspace unchanged', async () => {
    setUp(recordedApply('via-call-tool-allow'));
    await stageBoth();
    const sending = controller.send('change it');
    await vi.waitFor(() => expect(flow.isReviewing).toBe(true));
    flow.setAll('accepted');

    controller.stop();
    expect(controller.view.statusText).toBe('Stopping…');
    await sending;

    expect(flow.isReviewing).toBe(false);
    expect(flow.changeset.isEmpty).toBe(true);
    expect(controller.view).toMatchObject({ status: 'cancelled', statusText: 'Cancelled, workspace unchanged' });
    expect(reviewCards(controller.view.items)[0]).toMatchObject({ phase: 'discarded' });
    expect(sessions.inputs).toHaveLength(1); // No approval was sent.
    expect(onDisk('src/a.py')).toBe(numbered(40));
  });

  it('starts a fresh session after a stop during review, since the old one holds an unanswered approval', async () => {
    setUp([...recordedApply('via-call-tool-allow'), ...loadRecording('subagent-read').turns]);
    await stageBoth();
    const first = controller.send('change it');
    await vi.waitFor(() => expect(flow.isReviewing).toBe(true));
    const before = controller.view.sessionUrl;
    controller.stop();
    await first;
    await controller.send('next');
    expect(controller.view.sessionUrl).not.toBe(before);
  });

  it('Stop while staging discards what was staged', async () => {
    setUp(loadRecording('subagent-read').turns);
    await stageBoth();
    const sending = controller.send('go');
    controller.stop();
    await sending;
    expect(flow.changeset.isEmpty).toBe(true);
    expect(onDisk('src/a.py')).toBe(numbered(40));
  });

  it('New chat discards staged edits; a finished run keeps them for a follow-up', async () => {
    setUp(loadRecording('subagent-read').turns);
    await stageBoth();
    await controller.send('go');
    expect(flow.changeset.isEmpty).toBe(false);
    controller.newChat();
    expect(flow.changeset.isEmpty).toBe(true);
  });

  it('Undo from the card restores the file and marks the card', async () => {
    setUp(recordedApply('preloaded-allow'));
    await stageBoth();
    const sending = controller.send('change it');
    await vi.waitFor(() => expect(flow.isReviewing).toBe(true));
    flow.setAll('accepted');
    await flow.applyDecisions();
    await sending;
    await flow.undoLast();
    expect(onDisk('src/a.py')).toBe(numbered(40));
    expect(onDisk('src/b.py')).toBe(numbered(40));
    expect(reviewCards(controller.view.items)[0]).toMatchObject({ phase: 'undone', canUndo: false });
    expect(reviewCards(controller.view.items)[0]?.text).toContain('reverted 2 files');
  });

  it('other gated tools still use the plain approval', async () => {
    setUp(loadRecording('preloaded-allow').turns);
    const sending = controller.send('go');
    await vi.waitFor(() => expect(controller.view.status).toBe('awaiting-approval'));
    expect(flow.isReviewing).toBe(false);
    controller.decide(tools(controller.view.items)[0]?.id ?? '', true);
    await sending;
    expect(controller.view.status).toBe('done');
  });
});

describe('RunViewBuilder heartbeat and status text', () => {
  const message = (id: string, content: string, toolCalls: unknown[] = []): TurnEvent =>
    ({ type: 'model.message', id, threadId: 'main', content, toolCalls, createdAt: '2026-11-04T00:00:00Z' }) as unknown as TurnEvent;

  it('counts seconds while the model is silent, and stops once output arrives', () => {
    let now = 1000;
    const view = new RunViewBuilder(() => now);
    view.userMessage('hi');
    expect(view.snapshot.statusText).toBe('Waiting for the model…');
    now += 23_000;
    view.heartbeat();
    expect(view.snapshot.statusText).toBe('Waiting for the model… 23 s');

    // The empty shell is not output.
    const shell = message('m1', '');
    view.apply(shell, shell);
    now += 1_000;
    view.heartbeat();
    expect(view.snapshot.statusText).toBe('Waiting for the model… 24 s');

    const text = message('m1', 'hello');
    view.apply(text, text);
    expect(view.snapshot.statusText).toBe('Streaming…');
    now += 5_000;
    view.heartbeat();
    expect(view.snapshot.statusText).toBe('Streaming…');
  });

  it('counts again from zero once tools have answered', () => {
    let now = 0;
    const view = new RunViewBuilder(() => now);
    view.userMessage('hi');
    const call = message('m1', '', [{ id: 'c1', toolInfo: { type: 'mcp', name: 'read_file', serverName: 's' }, function: { arguments: '{}' } }]);
    view.apply(call, call);
    expect(view.snapshot.statusText).toBe('Running tools…');
    now = 9_000;
    view.heartbeat();
    expect(view.snapshot.statusText).toBe('Running tools…');
    const response = { type: 'tool.response', id: 'r1', threadId: 'main', toolCallId: 'c1', content: 'ok', createdAt: '2026-11-04T00:00:01Z' } as unknown as TurnEvent;
    view.apply(response, response);
    now = 12_000;
    view.heartbeat();
    expect(view.snapshot.statusText).toBe('Waiting for the model… 3 s');
  });

  it('does not overwrite Stopping, and has no heartbeat after the run ends', () => {
    let now = 0;
    const view = new RunViewBuilder(() => now);
    view.userMessage('hi');
    view.markStopping();
    now = 5_000;
    view.heartbeat();
    expect(view.snapshot.statusText).toBe('Stopping…');
    view.applyOutcome({ status: 'cancelled', reason: 'client-cancelled' });
    now = 9_000;
    view.heartbeat();
    expect(view.snapshot.statusText).toBe('Cancelled, workspace unchanged');
  });

  it('does not claim the workspace is unchanged after an apply landed', () => {
    const card = {
      id: 'r1',
      phase: 'applied' as const,
      text: 'Applied 2/3 hunks in 2 files',
      files: 2,
      hunks: 3,
      accepted: 2,
      rejected: 1,
      pending: 0,
      canUndo: true,
      warning: undefined,
    };
    const cancelled = new RunViewBuilder();
    cancelled.userMessage('hi');
    cancelled.review(card);
    cancelled.applyOutcome({ status: 'cancelled', reason: 'client-cancelled' });
    expect(cancelled.snapshot.statusText).toContain('Applied 2/3 hunks');
    expect(cancelled.snapshot.statusText).toContain('Undo');
    expect(cancelled.snapshot.statusText).not.toContain('unchanged');

    const failed = new RunViewBuilder();
    failed.userMessage('hi');
    failed.review(card);
    failed.fail('boom');
    expect(failed.snapshot.statusText).toContain('Applied 2/3 hunks');
    expect(failed.snapshot.statusText).not.toContain('unchanged');
  });

  it('updates one card per review rather than adding another', () => {
    const view = new RunViewBuilder();
    const base = { id: 'r1', files: 1, hunks: 1, accepted: 0, rejected: 0, pending: 1, canUndo: false, warning: undefined };
    view.review({ ...base, phase: 'reviewing', text: 'one' });
    view.review({ ...base, phase: 'applied', text: 'two', accepted: 1, pending: 0, canUndo: true });
    expect(view.snapshot.items.filter((item) => item.kind === 'review')).toHaveLength(1);
    expect(view.snapshot.items.at(-1)).toMatchObject({ phase: 'applied', text: 'two', canUndo: true });
  });
});
