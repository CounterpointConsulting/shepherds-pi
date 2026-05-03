import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { Goal, AgentRun, ViewMode, FocusZone, ChatMessage } from './types.js';
import { OrchestratorManager } from './orchestrator/manager.js';
import type { ShepherdsPiConfig } from './config/index.js';
import { GoalTabs } from './components/GoalTabs.js';
import { ChatPane } from './components/ChatPane.js';
import { AgentList } from './components/AgentList.js';
import { AgentDetail } from './components/AgentDetail.js';
import { PlanView } from './components/PlanView.js';
import { InputBar } from './components/InputBar.js';

export function App({ config }: { config: ShepherdsPiConfig }) {
  const { exit } = useApp();

  // ─── Manager ─────────────────────────────────────────────────
  const managerRef = useRef<OrchestratorManager | null>(null);
  if (!managerRef.current) {
    managerRef.current = new OrchestratorManager(config);
  }
  const manager = managerRef.current;

  // ─── State (triggers re-renders) ──────────────────────────────
  const [, setTick] = useState(0);
  const forceUpdate = useCallback(() => setTick(t => t + 1), []);

  const [focusZone, setFocusZone] = useState<FocusZone>('chat');
  const [viewMode, setViewMode] = useState<ViewMode>('default');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentCursor, setAgentCursor] = useState(0);

  // Subscribe to manager changes
  useEffect(() => {
    const unsub = manager.onChange(forceUpdate);
    return () => {
      unsub();
      manager.dispose();
    };
  }, [manager, forceUpdate]);

  // ─── Derived state from manager ──────────────────────────────
  const goals = manager.allGoals;
  const activeGoalId = manager.activeGoalId;
  const activeGoal = manager.getActiveGoal();
  const messagesForGoal = activeGoalId ? manager.getMessages(activeGoalId) : [];
  const agentsForGoal = activeGoalId ? manager.getAgents(activeGoalId) : [];
  const planForGoal = activeGoalId ? manager.getPlan(activeGoalId) : null;
  const askUserActive = activeGoalId ? manager.getAskUserQuestion(activeGoalId) !== null : false;

  const selectedAgent = selectedAgentId
    ? agentsForGoal.find(a => a.id === selectedAgentId) ?? null
    : null;

  // Keep cursor in bounds when agents change
  useEffect(() => {
    if (agentCursor >= agentsForGoal.length) {
      setAgentCursor(Math.max(0, agentsForGoal.length - 1));
    }
  }, [agentsForGoal.length, agentCursor]);

  // ─── Agent list navigation ───────────────────────────────────
  const navigateAgent = useCallback((direction: 'up' | 'down') => {
    setAgentCursor(prev => {
      if (direction === 'up') return Math.max(0, prev - 1);
      return Math.min(agentsForGoal.length - 1, prev + 1);
    });
  }, [agentsForGoal.length]);

  // Keep selected agent in sync with cursor
  useEffect(() => {
    if (agentsForGoal.length > 0 && focusZone === 'agents') {
      setSelectedAgentId(agentsForGoal[agentCursor]?.id ?? null);
    }
  }, [agentCursor, focusZone, agentsForGoal]);

  // ─── Keybindings ──────────────────────────────────────────────
  useInput((input, key) => {
    // Global: Ctrl+C / Ctrl+D = exit
    if (input === 'c' && key.ctrl) { exit(); return; }
    if (input === 'd' && key.ctrl) { exit(); return; }

    // Number keys 1-9 switch goals (global, any view)
    if (/^[1-9]$/.test(input)) {
      const idx = parseInt(input) - 1;
      if (idx < goals.length) {
        handleGoalSelect(goals[idx].id);
      }
      return;
    }

    // Plan view: Escape or 'p' to go back
    if (viewMode === 'plan') {
      if (key.escape || input === 'p') { setViewMode('default'); }
      return;
    }

    // Agent expanded view: Escape to go back
    if (viewMode === 'agentExpanded') {
      if (key.escape) { setViewMode('default'); }
      return;
    }

    // Default view
    if (viewMode === 'default') {
      // Tab: toggle focus
      if (input === '\t') {
        setFocusZone(prev => prev === 'chat' ? 'agents' : 'chat');
        return;
      }

      // 'p': plan view (only when chat focused and no active input)
      if (input === 'p' && focusZone === 'chat') {
        setViewMode('plan');
        return;
      }

      // Agent zone navigation
      if (focusZone === 'agents') {
        if (key.upArrow) { navigateAgent('up'); return; }
        if (key.downArrow) { navigateAgent('down'); return; }
        if (key.return) {
          const agent = agentsForGoal[agentCursor];
          if (agent) {
            setSelectedAgentId(agent.id);
            setViewMode('agentExpanded');
          }
          return;
        }
      }
    }
  });

  // ─── Handle input submit ──────────────────────────────────────
  const handleSubmit = useCallback((value: string) => {
    if (!value.trim()) return;

    // If no active goal, treat input as a new goal
    if (!activeGoalId) {
      manager.startGoal(value.trim());
      return;
    }

    // Otherwise, send to the active goal
    manager.sendUserMessage(value.trim());
  }, [manager, activeGoalId]);

  // ─── Goal switching ───────────────────────────────────────────
  const handleGoalSelect = useCallback((goalId: string) => {
    manager.switchGoal(goalId);
    setAgentCursor(0);
    setSelectedAgentId(null);
    setViewMode('default');
    setFocusZone('chat');
  }, [manager]);

  // ─── Welcome screen when no goals ─────────────────────────────
  if (goals.length === 0) {
    return (
      <Box flexDirection="column" height="100%" justifyContent="center" alignItems="center">
        <Text bold color="cyan">🐑 Shepherds Pi</Text>
        <Box marginTop={1}>
          <Text dimColor>Type a goal to get started</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Example: "Add user authentication with JWT tokens"</Text>
        </Box>
        <Box marginTop={1}>
          <InputBar
            value=""
            onChange={() => {}}
            onSubmit={handleSubmit}
            askUserActive={false}
            focusZone="chat"
          />
        </Box>
      </Box>
    );
  }

  // ─── Main render ──────────────────────────────────────────────

  return (
    <Box flexDirection="column" height="100%">
      {/* Header with goal tabs */}
      <GoalTabs
        goals={goals}
        activeGoalId={activeGoalId ?? ''}
        onSelect={handleGoalSelect}
      />

      {/* Main content area */}
      <Box flexGrow={1} flexDirection="row">
        {viewMode === 'plan' ? (
          <PlanView plan={planForGoal} agents={agentsForGoal} />
        ) : viewMode === 'agentExpanded' && selectedAgent ? (
          <AgentDetail
            agent={selectedAgent}
            expanded
            onBack={() => setViewMode('default')}
          />
        ) : (
          <>
            {/* Chat pane */}
            <Box
              flexGrow={1}
              flexDirection="column"
              borderStyle={focusZone === 'chat' ? 'bold' : 'single'}
              borderColor={focusZone === 'chat' ? 'cyan' : 'gray'}
            >
              <ChatPane messages={messagesForGoal} goalStatus={activeGoal?.status} />
            </Box>

            {/* Agent pane */}
            <Box
              width="35%"
              flexDirection="column"
              borderStyle={focusZone === 'agents' ? 'bold' : 'single'}
              borderColor={focusZone === 'agents' ? 'cyan' : 'gray'}
            >
              <AgentList
                agents={agentsForGoal}
                cursorIndex={focusZone === 'agents' ? agentCursor : -1}
                selectedId={selectedAgentId}
                onSelect={(id) => {
                  setSelectedAgentId(id);
                }}
              />

              {selectedAgent && (
                <AgentDetail
                  agent={selectedAgent}
                  expanded={false}
                  onBack={() => setViewMode('default')}
                />
              )}
            </Box>
          </>
        )}
      </Box>

      {/* Input bar */}
      <InputBar
        value=""
        onChange={() => {}}
        onSubmit={handleSubmit}
        askUserActive={askUserActive}
        focusZone={focusZone}
      />

      {/* Status bar */}
      <StatusBar
        focusZone={focusZone}
        viewMode={viewMode}
        activeGoal={activeGoal}
      />
    </Box>
  );
}

// ─── Status Bar ──────────────────────────────────────────────────

function StatusBar({ focusZone, viewMode, activeGoal }: {
  focusZone: FocusZone;
  viewMode: ViewMode;
  activeGoal: Goal | null;
}) {
  const focusIndicator = focusZone === 'chat' ? '💬 Chat' : '🔍 Agents';
  return (
    <Box>
      <Text bold color={focusZone === 'chat' ? 'cyan' : 'yellow'}>
        {' '}{focusIndicator}
      </Text>
      <Text dimColor>
        {'  '}Tab:switch
        {'  '}↑↓:navigate
        {'  '}Enter:expand
        {'  '}Esc:back
        {'  '}p:plan
        {'  '}1-9:switch goal
        {'  '}Ctrl+C:quit
      </Text>
    </Box>
  );
}
