import fs from 'node:fs';
import path from 'node:path';

export interface PersonaConfig {
  name: string;
  dir: string;
  systemPrompt: string;
  model: string;
  skillsDir: string | null;
  toolsJson: string | null;
}

/**
 * Load all personas from the configured personas directory.
 * Each persona is a subdirectory containing at minimum SYSTEM.md and model.txt.
 */
export function loadPersonas(personasDir: string): Map<string, PersonaConfig> {
  const personas = new Map<string, PersonaConfig>();

  if (!fs.existsSync(personasDir)) {
    return personas;
  }

  const entries = fs.readdirSync(personasDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const personaDir = path.join(personasDir, entry.name);
    const config = loadPersona(entry.name, personaDir);
    if (config) {
      personas.set(entry.name, config);
    }
  }

  return personas;
}

/**
 * Load a single persona by name from the personas directory.
 */
export function loadPersona(name: string, personaDir: string): PersonaConfig | null {
  const systemPromptPath = path.join(personaDir, 'SYSTEM.md');
  const modelPath = path.join(personaDir, 'model.txt');
  const skillsPath = path.join(personaDir, 'skills');
  const toolsPath = path.join(personaDir, 'tools.json');

  if (!fs.existsSync(systemPromptPath)) {
    return null;
  }

  const systemPrompt = fs.readFileSync(systemPromptPath, 'utf-8');
  const model = fs.existsSync(modelPath)
    ? fs.readFileSync(modelPath, 'utf-8').trim()
    : 'openrouter/anthropic/claude-sonnet-4';

  const skillsDir = fs.existsSync(skillsPath) ? skillsPath : null;
  const toolsJson = fs.existsSync(toolsPath)
    ? fs.readFileSync(toolsPath, 'utf-8')
    : null;

  return {
    name,
    dir: personaDir,
    systemPrompt,
    model,
    skillsDir,
    toolsJson,
  };
}

/**
 * Build the full system prompt for an agent by combining the persona's
 * base system prompt with instructions and context.
 */
export function buildAgentPrompt(
  persona: PersonaConfig,
  instructions: string,
  context?: string,
): string {
  let prompt = persona.systemPrompt;

  prompt += '\n\n## Your Task\n\n' + instructions;

  if (context) {
    prompt += '\n\n## Context\n\n' + context;
  }

  // Always append the summarize reminder
  prompt += '\n\n## IMPORTANT\n\nWhen you have completed your task (or cannot make further progress), you MUST call the summarize skill to write your result to /output/result.json. Then commit and push any changes to the current branch.';

  return prompt;
}
