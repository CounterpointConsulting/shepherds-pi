#!/usr/bin/env npx tsx
import { buildDockerImage } from '../agent/spawner.js';

buildDockerImage().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
