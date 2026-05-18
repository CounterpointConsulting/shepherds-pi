import fs from 'node:fs';
import path from 'node:path';

const distPath = path.join(process.cwd(), 'dist');

if (fs.existsSync(distPath)) {
  fs.rmSync(distPath, { recursive: true, force: true });
  console.log('Removed dist/');
} else {
  console.log('dist/ does not exist; nothing to clean');
}
