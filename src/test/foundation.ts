import { ShepherdsDB } from '../db/index.js';
import { loadConfig } from '../config/index.js';
import { loadPersonas, buildAgentPrompt } from '../persona/index.js';

// Test DB
const db = new ShepherdsDB(':memory:');
db.createRun('test-1', 'Test goal');
const run = db.getRun('test-1');
console.log('DB Run:', run?.goal);

db.appendLog('test-1', 'goal_set', { goal: 'Test goal' }, 'Goal set');
const log = db.getRunLog('test-1');
console.log('DB Log entries:', log.length);

db.close();

// Test Config
const config = loadConfig('./shepherds-pi.yaml');
console.log('Config project:', config.project.name);
console.log('Config personas dir:', config.personasDir);
console.log('API key set:', !!config.openrouter.apiKey);

// Test Persona loader
const personas = loadPersonas(config.personasDir);
console.log('Personas loaded:', [...personas.keys()]);
const architect = personas.get('architect');
if (architect) {
  console.log('Architect model:', architect.model);
  console.log('Has skills:', !!architect.skillsDir);
  const prompt = buildAgentPrompt(architect, 'Analyze the codebase', 'This is a Next.js app');
  console.log('Built prompt length:', prompt.length);
  console.log('Prompt includes IMPORTANT:', prompt.includes('IMPORTANT'));
}
