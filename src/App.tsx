import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
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
  const [chatScrollOffset, setChatScrollOffset] = useState(0);

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
  const maxChatScrollOffset = useMemo(
    () => Math.max(0, messagesForGoal.length - 1),
    [messagesForGoal.length],
  );
  const agentsForGoal = activeGoalId ? manager.getAgents(activeGoalId) : [];
  const planForGoal = activeGoalId ? manager.getPlan(activeGoalId) : null;
  const askUserActive = activeGoalId ? manager.getAskUserQuestion(activeGoalId) !== null : false;

  useEffect(() => {
    setChatScrollOffset(prev => Math.min(prev, maxChatScrollOffset));
  }, [maxChatScrollOffset]);

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

    if (viewMode === 'agentExpanded') {
      if (key.escape) { setViewMode('default'); }
      return;
    }

    if (viewMode === 'plan') {
      if (key.escape || input === 'p') { setViewMode('default'); }
      return;
    }

    // Ink exposes tab as key.tab (input is empty for non-alphanumeric keys)
    if (key.tab) {
      setFocusZone(prev => prev === 'chat' ? 'agents' : 'chat');
      return;
    }

    // Chat-focused navigation: scroll chat history
    if (focusZone === 'chat') {
      if (key.pageUp) {
        setChatScrollOffset(prev => Math.min(maxChatScrollOffset, prev + 10));
        return;
      }
      if (key.pageDown) {
        setChatScrollOffset(prev => Math.max(0, prev - 10));
        return;
      }
      if (key.upArrow) {
        setChatScrollOffset(prev => Math.min(maxChatScrollOffset, prev + 1));
        return;
      }
      if (key.downArrow) {
        setChatScrollOffset(prev => Math.max(0, prev - 1));
        return;
      }
      // Reserve printable keys for InputBar so typing doesn't trigger global hotkeys.
      return;
    }

    if (/^[1-9]$/.test(input)) {
      const idx = parseInt(input) - 1;
      if (idx < goals.length) handleGoalSelect(goals[idx].id);
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

    if (key.upArrow) { navigateAgent('up'); return; }
    if (key.downArrow) { navigateAgent('down'); return; }
    if (key.return && selectedAgent) { setViewMode('agentExpanded'); return; }
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
    setChatScrollOffset(0);
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
                scrollOffset={chatScrollOffset}
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
      <StatusBar
        focusZone={focusZone}
        viewMode={viewMode}
        activeGoal={activeGoal}
        chatScrollOffset={chatScrollOffset}
      />
    </Box>
  );
}

// ─── Status Bar ──────────────────────────────────────────────────

function StatusBar({ focusZone, viewMode, activeGoal, chatScrollOffset }: {
  focusZone: FocusZone;
  viewMode: ViewMode;
  activeGoal: Goal | null;
  chatScrollOffset: number;
}) {
  const focusIndicator = focusZone === 'chat' ? 'Chat' : 'Agents';
  const typingMode = focusZone === 'chat'
    ? 'Typing mode: Chat (hotkeys off)'
    : 'Typing mode: Hotkeys';

  return (
    <Box>
      <Text bold color={focusZone === 'chat' ? 'cyan' : 'yellow'}>
        {' '}{focusIndicator}
      </Text>
      <Text color={focusZone === 'chat' ? 'cyan' : 'yellow'}>
        {'  '}{typingMode}
      </Text>
      <Text dimColor>
        {'  '}Tab:focus
        {'  '}(Chat) ↑↓/PgUp/PgDn:scroll
        {'  '}(Agents) ↑↓:nav
        {'  '}Enter:open
        {'  '}a:agent detail
        {'  '}p:plan
        {'  '}1-9:goal
        {'  '}Esc:back
        {'  '}Ctrl+C:quit
      </Text>
      {focusZone === 'chat' && chatScrollOffset > 0 && (
        <Text color="yellow">  (Viewing history)</Text>
      )}
    </Box>
  );
}
