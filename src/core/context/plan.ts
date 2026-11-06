/**
 * Plan, then implement. A change in agent mode runs as two turns of one TrueForge session: the first ends with a
 * plan, which the panel shows, and the second carries it out. The agent still chooses what to read and change;
 * ForgeLens only splits the turn, so the plan is on screen before any edit and the edits follow it.
 */

export interface PlanStep {
  path: string;
  /** The functions or lines to change or add. */
  what: string;
  why: string;
}

/** Reads and searches allowed in the plan turn, the explorer's included. */
export const PLAN_READ_LIMIT = 3;

/** Added to the first turn of every agent request. A question is answered as before. */
export const PLAN_RULE = [
  '## How to answer',
  'If the request is a question, answer it.',
  'If it asks for a change, this turn is for the plan only. Do not stage anything yet. Delegate the lookups: call create_sub_agent once to start an explorer, and give it the request, the Context Pack\'s file list, and these rules: use search_code for its lookups, at most 3 searches (search_code is loaded on demand: get_tool_info, then call_tool), and return only file:line targets with one reason each. This turn allows 3 reads or searches in all, so do not read or search yourself. Then reply with a short plan and stop: start with the line "Plan:", then one line per change, in this form:',
  '- <path>: <the exact functions or lines you will change or add>. Why: <one line>',
  'List every file the change needs, including its tests, docs and changelog where the project keeps them. You will implement the plan in the next turn.',
].join('\n');

/** The second turn, sent by ForgeLens once the plan is in. */
export const IMPLEMENT_MESSAGE =
  'Implement your plan now. Stage all edits with as few stage_edit calls as possible, run the tests once with run_command target=staged, fix only what fails, then call apply_changes once.';

const PLAN_HEADING = /^\s*(?:#+\s*)?(?:\*\*)?plan(?:\*\*)?\s*:?\s*(?:\*\*)?\s*$/i;
const BULLET = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/;
const PATH = /^[`*]*([\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]+|[\w.-]+\/[\w./-]+)[`*]*\s*(?:\([^)]*\))?\s*[:–-]\s*(.*)$/;

/** Reads a plan written in the form PLAN_RULE asks for. Anything else, such as an answer, gives undefined. */
export function parsePlan(output: string): PlanStep[] | undefined {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => PLAN_HEADING.test(line) || /^\s*(?:\*\*)?plan(?:\*\*)?\s*:\s*\S/i.test(line));
  if (start < 0) return undefined;
  const steps: PlanStep[] = [];
  for (const line of lines.slice(start + 1)) {
    const bullet = BULLET.exec(line);
    if (!bullet?.[1]) {
      // A line that continues the step above, such as a sub-bullet or a wrapped line, belongs to it.
      const last = steps.at(-1);
      if (last && line.trim() && /^\s+/.test(line)) appendTo(last, line.trim().replace(/^[-*]\s+/, ''));
      continue;
    }
    const indented = /^\s{2,}/.test(line);
    const match = PATH.exec(bullet[1].trim());
    if (match?.[1] && !indented) {
      const step: PlanStep = { path: match[1].replace(/^\.\//, ''), what: '', why: '' };
      appendTo(step, match[2] ?? '');
      steps.push(step);
    } else if (steps.length > 0) {
      appendTo(steps.at(-1) as PlanStep, bullet[1].trim());
    }
  }
  for (const step of steps) step.what = step.what.replace(/[.;,]\s*$/, '');
  return steps.length > 0 ? steps : undefined;
}

function appendTo(step: PlanStep, text: string): void {
  const clean = text.replace(/\*\*/g, '').trim();
  if (!clean) return;
  const why = /\bwhy\s*:\s*/i.exec(clean);
  if (why) {
    const what = clean.slice(0, why.index).trim().replace(/[.;,]\s*$/, '');
    if (what) step.what = step.what ? `${step.what}; ${what}` : what;
    const reason = clean.slice(why.index + why[0].length).trim();
    step.why = step.why ? `${step.why} ${reason}` : reason;
  } else if (step.why) {
    step.why = `${step.why} ${clean}`;
  } else {
    step.what = step.what ? `${step.what}; ${clean}` : clean;
  }
}
