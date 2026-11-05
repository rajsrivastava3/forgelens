import type { RunView } from '../core/trueforge/runView';

export interface PanelState {
  view: RunView;
  busy: boolean;
  largeText: boolean;
  /** Set when the panel cannot work yet, for example TrueForge is not running. */
  banner: string | undefined;
}

export type ToWebview =
  | { type: 'state'; state: PanelState }
  /** Test hook: presses a real button and reports how quickly the page reacted. */
  | { type: 'probe-click'; selector: string }
  /** Test hook: sends the page the key press a person would make. */
  | { type: 'probe-ctrl-z' }
  /** Test hook: reports whether something is on screen, and its text. */
  | { type: 'probe-read'; selector: string }
  /** Test hook: reports whether something sits inside the visible part of the transcript. */
  | { type: 'probe-in-view'; selector: string }
  /** Test hook: types into the message box as a person would. */
  | { type: 'probe-type'; text: string }
  /** The picked mention, to put where the user typed @. */
  | { type: 'insert-mention'; mention: string };

export type ToExtension =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'decide'; toolCallId: string; allow: boolean }
  | { type: 'new-chat' }
  | { type: 'open-session' }
  | { type: 'setup' }
  | { type: 'review-open' }
  | { type: 'review-apply' }
  | { type: 'undo' }
  | { type: 'pick-mention' }
  | { type: 'switch-model' }
  | { type: 'probe-result'; clicked: boolean; reactionMs: number; statusText: string };
