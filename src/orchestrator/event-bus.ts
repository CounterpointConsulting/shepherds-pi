import { EventEmitter } from 'node:events';

// ─── Event types ─────────────────────────────────────────────────

export type OrchestratorEvent =
  | { type: 'goal_status_changed'; status: string; message?: string }
  | { type: 'plan_updated'; steps: unknown[] }
  | { type: 'agent_spawned'; agentId: string; persona: string; branch?: string }
  | { type: 'agent_event'; agentId: string; event: Record<string, unknown> }
  | { type: 'agent_completed'; agentId: string; result: unknown }
  | { type: 'agent_failed'; agentId: string; error: string }
  | { type: 'user_question'; question: string; resolve: (response: string) => void }
  | { type: 'branch_created'; name: string; base: string }
  | { type: 'run_log_entry'; entry: { eventType: string; summary: string } }
  | { type: 'coordinator_message'; content: string };

/**
 * Typed event bus for communication between the orchestrator,
 * its tools, and the TUI.
 */
export class OrchestratorEventBus {
  private emitter = new EventEmitter();

  emit(event: OrchestratorEvent): void {
    this.emitter.emit('event', event);
  }

  onEvent(listener: (event: OrchestratorEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  /** Emit a user question event and return a promise that resolves when answered */
  askUser(question: string): Promise<string> {
    return new Promise<string>((resolve) => {
      this.emit({ type: 'user_question', question, resolve });
    });
  }
}
