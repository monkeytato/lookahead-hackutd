/**
 * npm run validate -- [--iterations 50] [--random-seeds 30] [--perturb mild|default|harsh] [--seed 1] [--no-fixes]
 *                     [--model cascade|ensemble] [--reality legacy|perturbed|prior_predictive]
 * Writes reports/validation-<date>-<perturb>.md and .json; prints a summary table.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { runValidation, type PerturbLevel, type ValidateOptions } from './harness';
import { consoleReport, markdownReport } from './report';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const num = (name: string, d: number) => {
  const v = Number(arg(name));
  return Number.isFinite(v) && v >= 0 ? v : d;
};

const perturb = (arg('perturb') ?? 'default') as PerturbLevel;
if (!['mild', 'default', 'harsh'].includes(perturb)) {
  console.error('--perturb must be mild, default or harsh');
  process.exit(2);
}
const opts: ValidateOptions = {
  iterations: num('iterations', 50),
  randomSeeds: num('random-seeds', 30),
  perturb,
  seed: num('seed', 1),
  skipFixes: process.argv.includes('--no-fixes'),
  model: (arg('model') ?? 'cascade') as ValidateOptions['model'],
  reality: (arg('reality') ?? 'legacy') as ValidateOptions['reality'],
};
if (!['cascade', 'ensemble'].includes(opts.model!) || !['legacy', 'perturbed', 'prior_predictive'].includes(opts.reality!)) {
  console.error('--model must be cascade or ensemble; --reality legacy, perturbed or prior_predictive');
  process.exit(2);
}

const report = runValidation(opts, (r, i, n) => process.stderr.write(`\r[${i + 1}/${n}] ${r.id.padEnd(28)}`));
process.stderr.write('\n');
console.log(consoleReport(report));

mkdirSync('reports', { recursive: true });
const tag = opts.model === 'ensemble' || opts.reality !== 'legacy' ? `-${opts.model}-${opts.reality}` : '';
const base = `reports/validation-${report.startedAt.slice(0, 10)}-${perturb}${tag}`;
writeFileSync(`${base}.md`, markdownReport(report));
writeFileSync(`${base}.json`, JSON.stringify(report, null, 1));
if (process.argv.includes('--example')) writeFileSync('reports/example.md', markdownReport(report));
console.log(`\nWrote ${base}.md and ${base}.json`);
