import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  DefaultResourceLoader,
} from '@mariozechner/pi-coding-agent';
import type { AgentSession } from '@mariozechner/pi-coding-agent';
import { OrchestratorEventBus } from './event-bus.js';
import { createOrchestratorTools } from './tools.js';
import { ShepherdsDB } from '../db/index.js';
import type { ShepherdsPiConfig } from '../config/index.js';
import { getModuleDir } from '../utils.js';

export interface OrchestratorSession {
  session: AgentSession;
  eventBus: OrchestratorEventBus;
  db: ShepherdsDB;
  runId: string;
}

/**
 * Create the orchestrator session — a pi SDK session with the coordinator
 * persona and all orchestration tools. No coding tools (read, write, edit,
 * bash) — only orchestration tools are available.
 */
export async function createOrchestratorSession(deps: {
  config: ShepherdsPiConfig;
  goal: string;
}): Promise<OrchestratorSession> {
  const { config, goal } = deps;

  // ─── Database ─────────────────────────────────────────────────
  const dbDir = path.join(config.project.repoPath, '.shepherds-pi');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  const dbPath = path.join(dbDir, 'shepherds.db');
  const db = new ShepherdsDB(dbPath);

  // ─── Create run ───────────────────────────────────────────────
  const runId = `run-${crypto.randomUUID().substring(0, 8)}`;
  db.createRun(runId, goal);
  db.appendLog(runId, 'goal_set', { goal }, `Goal set: ${goal}`);

  // ─── Event bus ────────────────────────────────────────────────
  const eventBus = new OrchestratorEventBus();

  // ─── Get run ID for tools ─────────────────────────────────────
  const getRunId = () => runId;

  // ─── Create tools ─────────────────────────────────────────────
  const tools = createOrchestratorTools({ eventBus, db, config, getRunId });

  // ─── Load coordinator system prompt ───────────────────────────
  const coordinatorPromptPath = path.join(
    getModuleDir(import.meta.url),
    'coordinator.md',
  );
  const systemPromptOverride = fs.readFileSync(coordinatorPromptPath, 'utf-8');

  // ─── Auth + Model Registry ────────────────────────────────────
  const authStorage = AuthStorage.create();

  // Set OpenRouter API key if provided
  if (config.openrouter.apiKey) {
    authStorage.setRuntimeApiKey('openrouter', config.openrouter.apiKey);
  }

  const modelRegistry = ModelRegistry.create(authStorage);

  // Resolve the coordinator's model
  const modelRef = config.coordinator.model;
  let model: ReturnType<typeof modelRegistry.find> = undefined;

  const openrouterPrefix = 'openrouter/';
  if (modelRef.startsWith(openrouterPrefix)) {
    const modelId = modelRef.substring(openrouterPrefix.length);
    model = modelRegistry.find('openrouter', modelId);
  }

  if (!model) {
    const available = await modelRegistry.getAvailable();
    model = available[0];
  }

  if (!model) {
    throw new Error(
      `Could not find model "${modelRef}". Ensure OPENROUTER_API_KEY is set.`
    );
  }

  // ─── Resource loader with system prompt override ───────────────
  const piAgentDir = path.join(
    process.env.PI_AGENT_DIR ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? '~', '.pi', 'agent')
  );
  const loader = new DefaultResourceLoader({
    cwd: config.project.repoPath,
    agentDir: piAgentDir,
    systemPromptOverride: () => systemPromptOverride,
    noExtensions: true,
  });
  await loader.reload();

  // ─── Create the pi session ────────────────────────────────────
  // Use noTools: "builtin" to disable coding tools — orchestrator only coordinates
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: config.coordinator.thinkingLevel as 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
    noTools: 'builtin',
    customTools: tools,
    resourceLoader: loader,
    cwd: config.project.repoPath,
  });

  return {
    session,
    eventBus,
    db,
    runId,
  };
}

/**
 * Start the orchestrator by sending the goal as the first prompt.
 */
export async function startOrchestrator(orchSession: OrchestratorSession, goal: string): Promise<void> {
  await orchSession.session.prompt(goal);
}
