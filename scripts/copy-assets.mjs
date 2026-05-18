import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();

const copies = [
  {
    from: path.join(projectRoot, 'src', 'orchestrator', 'coordinator.md'),
    to: path.join(projectRoot, 'dist', 'orchestrator', 'coordinator.md'),
  },
];

for (const item of copies) {
  if (!fs.existsSync(item.from)) {
    console.error(`Missing asset: ${item.from}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(item.to), { recursive: true });
  fs.copyFileSync(item.from, item.to);
  console.log(`Copied ${path.relative(projectRoot, item.from)} -> ${path.relative(projectRoot, item.to)}`);
}
