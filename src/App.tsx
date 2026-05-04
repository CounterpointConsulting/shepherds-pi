import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import type { Goal, ViewMode, FocusZone } from './types.js';
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
  const { stdout } = useStdout();
  const termHeight = stdout?.rows ?? 24;
  const termWidth = stdout?.columns ?? 80;

  // ─── Manager ─────────────────────────────────────────────────
  const managerRef = useRef<OrchestratorManager | null>(null);
  if (!managerRef.current) {
    managerRef.current = new OrchestratorManager(config);
  }
  const manager = managerRef.current;

  // ─── State ───────────────────────────────────────────────────
  const [, setTick] = useState(0);
  const forceUpdate = useCallback(() => setTick(t => t + 1), []);

  const [focusZone, setFocusZone] = useState<FocusZone>('chat');
  const [viewMode, setViewMode] = useState<ViewMode>('default');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentCursor, setAgentCursor] = useState(0);

  useEffect(() => {
    const unsub = manager.onChange(forceUpdate);
    return () => {
      unsub();
      manager.dispose();
    };
  }, [manager, forceUpdate]);

  // ─── Derived state ───────────────────────────────────────────
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

  useEffect(() => {
    if (agentsForGoal.length === 0) {
      setAgentCursor(0);
      setSelectedAgentId(null);
    } else if (agentCursor >= agentsForGoal.length) {
      setAgentCursor(agentsForGoal.length - 1);
    }
  }, [agentsForGoal.length, agentCursor]);

  // ─── Navigation ──────────────────────────────────────────────
  const navigateAgent = useCallback((direction: 'up' | 'down') => {
    if (agentsForGoal.length === 0) return;
    setAgentCursor(prev => {
      if (direction === 'up') return Math.max(0, prev - 1);
      return Math.min(agentsForGoal.length - 1, prev + 1);
    });
  }, [agentsForGoal.length]);

  useEffect(() => {
    if (agentsForGoal.length > 0) {
      setSelectedAgentId(agentsForGoal[agentCursor]?.id ?? null);
    }
  }, [agentCursor, agentsForGoal]);

  // ─── Keybindings ─────────────────────────────────────────────
  useInput((input, key) => {
    if (input === 'c' && key.ctrl) { exit(); return; }
    if (input === 'd' && key.ctrl) { exit(); return; }

    if (/^[1-9]$/.test(input)) {
      const idx = parseInt(input) - 1;
      if (idx < goals.length) handleGoalSelect(goals[idx].id);
      return;
    }

    if (viewMode === 'agentExpanded') {
      if (key.escape) { setViewMode('default'); return; }
      return;
    }

    if (viewMode === 'plan') {
      if (key.escape || input === 'p') { setViewMode('default'); }
      return;
    }

    if (input === '\t') {
      setFocusZone(prev => prev === 'chat' ? 'agents' : 'chat');
      return;
    }

    if (input === 'a' && agentsForGoal.length > 0) {
      setFocusZone('agents');
      if (selectedAgent) setViewMode('agentExpanded');
      return;
    }

    if (input === 'p') {
      setViewMode('plan');
      return;
    }

    if (focusZone === 'agents') {
      if (key.upArrow) { navigateAgent('up'); return; }
      if (key.downArrow) { navigateAgent('down'); return; }
      if (key.return && selectedAgent) { setViewMode('agentExpanded'); return; }
    }
  });

  // ─── Handlers ────────────────────────────────────────────────
  const handleSubmit = useCallback((value: string) => {
    if (!value.trim()) return;
    if (!activeGoalId) {
      manager.startGoal(value.trim());
    } else {
      manager.sendUserMessage(value.trim());
    }
  }, [manager, activeGoalId]);

  const handleGoalSelect = useCallback((goalId: string) => {
    manager.switchGoal(goalId);
    setAgentCursor(0);
    setSelectedAgentId(null);
    setViewMode('default');
    setFocusZone('chat');
  }, [manager]);

  // ─── Layout calculation ──────────────────────────────────────
  // The outermost Box MUST have height={termHeight} so yoga
  // constrains the total layout to the terminal viewport.
  // Children are allocated rows from this budget:
  //   GoalTabs    = 1 row (fixed)
  //   InputBar    = 3 rows (fixed: border-top + content + border-bottom)
  //   StatusBar   = 1 row (fixed)
  //   Main area   = termHeight - 5 rows (flexGrow absorbs remainder)
  const mainHeight = Math.max(termHeight - 5, 6);
  const agentPaneWidth = Math.max(Math.floor(termWidth * 0.35), 30);
  const chatBorderWidth = 2; // border chars left + right
  const chatInnerWidth = termWidth - agentPaneWidth - chatBorderWidth;
  // Content width inside chat pane (subtract border + padding)
  const chatContentWidth = Math.max(chatInnerWidth - 4, 20);
  // Chat pane rows: mainHeight minus 2 border rows
  const chatMaxRows = Math.max(mainHeight - 2, 4);

  // ─── Welcome screen ──────────────────────────────────────────
  if (goals.length === 0) {
    return (
      <Box flexDirection="column" height={termHeight} justifyContent="center" alignItems="center">
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

  // ─── Main render ─────────────────────────────────────────────
  return (
    <Box flexDirection="column" height={termHeight}>
      {/* 1 row — goal tabs */}
      <GoalTabs
        goals={goals}
        activeGoalId={activeGoalId ?? ''}
        onSelect={handleGoalSelect}
      />

      {/* Flexible middle — chat + agents */}
      <Box height={mainHeight} flexDirection="row">
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
              width={chatInnerWidth + chatBorderWidth}
              flexDirection="column"
              borderStyle={focusZone === 'chat' ? 'bold' : 'single'}
              borderColor={focusZone === 'chat' ? 'cyan' : 'gray'}
            >
              <ChatPane
                messages={messagesForGoal}
                goalStatus={activeGoal?.status}
                maxRows={chatMaxRows}
                contentWidth={chatContentWidth}
              />
            </Box>

            {/* Agent pane */}
            <Box
              width={agentPaneWidth}
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
                  const idx = agentsForGoal.findIndex(a => a.id === id);
                  if (idx >= 0) setAgentCursor(idx);
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

      {/* 3 rows — input bar */}
      <InputBar
        value=""
        onChange={() => {}}
        onSubmit={handleSubmit}
        askUserActive={askUserActive}
        focusZone={focusZone}
      />

      {/* 1 row — status bar */}
      <StatusBar focusZone={focusZone} viewMode={viewMode} activeGoal={activeGoal} />
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
        {'  '}↑↓:nav
        {'  '}Enter:open
        {'  '}a:agent detail
        {'  '}p:plan
        {'  '}Esc:back
        {'  '}1-9:goal
        {'  '}Ctrl+C:quit
      </Text>
    </Box>
  );
}
