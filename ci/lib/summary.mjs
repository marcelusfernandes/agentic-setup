// Appends Markdown to the GitHub job summary when running in Actions, and
// prints it otherwise, so the same script reads well locally.
import { appendFileSync } from 'node:fs';

/** @param {string} markdown */
export function appendSummary(markdown) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (target) appendFileSync(target, `${markdown}\n\n`);
  else console.log(markdown);
}
