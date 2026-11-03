import { describe, expect, it } from 'vitest';
import { resolveToolCall, shortArgs } from '../../src/core/trueforge/toolCalls';
import type { TurnEvent } from '../../src/core/trueforge/turnRunner';
import { loadRecording } from './helpers/fixtures';

function firstApprovalCall(name: string) {
  const [turn] = loadRecording(name).turns;
  const pause = turn?.find((event): event is Extract<TurnEvent, { type: 'tool.approval_required' }> => event.type === 'tool.approval_required');
  const ref = pause?.toolCalls[0];
  const message = turn?.find((event) => event.id === ref?.sourceEventId);
  if (message?.type !== 'model.message') throw new Error('recording has no source message');
  const call = message.toolCalls?.find((candidate) => candidate.id === ref?.id);
  if (!call) throw new Error('recording has no tool call');
  return call;
}

describe('resolveToolCall on recorded events', () => {
  it('resolves a directly called MCP tool', () => {
    expect(resolveToolCall(firstApprovalCall('preloaded-allow'))).toMatchObject({
      name: 'apply_changes_probe',
      server: 'forgelens-editor',
      viaCallTool: false,
      system: false,
    });
  });

  it('unwraps a deferred tool reached through call_tool', () => {
    const call = firstApprovalCall('deferred-deny');
    expect(call.toolInfo.name).toBe('call_tool');
    const resolved = resolveToolCall(call);
    expect(resolved).toMatchObject({ name: 'apply_changes_probe', server: 'forgelens-editor', viaCallTool: true, system: false });
    expect(resolved.args['summary']).toMatch(/^probe-deferred-deny-/);
  });

  it('unwraps a preloaded tool the model still routed through call_tool', () => {
    const call = firstApprovalCall('via-call-tool-allow');
    expect(call.toolInfo.name).toBe('call_tool');
    expect(resolveToolCall(call).name).toBe('apply_changes_probe');
  });

  it('resolves a call made by a subagent', () => {
    expect(resolveToolCall(firstApprovalCall('subagent-allow')).name).toBe('apply_changes_probe');
  });

  it('marks harness tools as system', () => {
    const [turn] = loadRecording('subagent-read').turns;
    const message = turn?.find((event) => event.type === 'model.message' && event.toolCalls?.length);
    if (message?.type !== 'model.message') throw new Error('no tool message');
    const call = message.toolCalls?.[0];
    if (!call) throw new Error('no tool call');
    expect(resolveToolCall(call)).toMatchObject({ name: 'create_sub_agent', system: true, viaCallTool: false });
  });
});

describe('resolveToolCall on partial or odd input', () => {
  it('shows the meta tool while call_tool arguments are still streaming', () => {
    const resolved = resolveToolCall({
      id: 'c1',
      function: { name: 'call_tool', arguments: '{"tool_na' },
      toolInfo: { type: 'truefoundry-system', name: 'call_tool' },
    });
    expect(resolved).toMatchObject({ name: 'call_tool', viaCallTool: true, system: true, args: {} });
  });

  it('parses nested input sent as a JSON string', () => {
    const resolved = resolveToolCall({
      id: 'c2',
      function: {
        name: 'call_tool',
        arguments: JSON.stringify({ tool_name: 'read_file', mcp_server: 's', input: '{"path":"a.py"}' }),
      },
      toolInfo: { type: 'truefoundry-system', name: 'call_tool' },
    });
    expect(resolved).toMatchObject({ name: 'read_file', server: 's', args: { path: 'a.py' } });
  });

  it('survives a fragment with no tool info yet', () => {
    expect(resolveToolCall({ id: 'c3' })).toMatchObject({ id: 'c3', name: '', args: {} });
  });

  it('falls back to the function name when tool info is missing', () => {
    expect(resolveToolCall({ id: 'c4', function: { name: 'read_file', arguments: '{}' } }).name).toBe('read_file');
  });
});

describe('shortArgs', () => {
  it('formats and truncates', () => {
    expect(shortArgs({ path: 'a.py', start_line: 2 })).toBe('path=a.py, start_line=2');
    const long = shortArgs({ query: 'x'.repeat(200) });
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long.endsWith('…')).toBe(true);
  });
});
