/**
 * Tool-name → human-readable label/icon/color mappings.
 *
 * Kept separate from the translator so it can be swapped or extended
 * (e.g. theme-based colors) without touching event-handling logic.
 */

export function getToolLabel(name: string): string {
  const labels: Record<string, string> = {
    spawn_agent: '🔧',
    spawn_agents: '🔧',
    create_branch: '🌿',
    list_branches: '📋',
    get_branch_diff: '📊',
    read_plan: '📖',
    update_plan: '📝',
    read_run_log: '📜',
    ask_user: '❓',
    update_goal_status: '🔄',
  };
  return labels[name] ?? '⚡';
}

export function getToolSummary(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'spawn_agent': return `Spawning ${a.persona} agent`;
    case 'spawn_agents': return `Spawning ${(a.agents as unknown[])?.length ?? '?'} agents`;
    case 'create_branch': return `Creating branch ${a.name}`;
    case 'read_plan': return 'Reading plan';
    case 'update_plan': return 'Updating plan';
    case 'read_run_log': return 'Reading run log';
    case 'ask_user': return String(a.question ?? 'Asking user');
    case 'update_goal_status': return `Status → ${a.status}`;
    case 'list_branches': return 'Listing branches';
    case 'get_branch_diff': return `Diff for ${a.branch}`;
    default: return name;
  }
}
