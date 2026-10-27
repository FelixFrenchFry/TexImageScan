import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { browserExecutable } from './browser.mjs';
import { corpusPath, readCorpus } from './lib/corpus-files.mjs';

const { manifest } = await readCorpus();
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: true });
try {
  const page = await browser.newPage();
  for (const [file, url] of [
    ['CC-BY-4.0.txt', 'https://creativecommons.org/licenses/by/4.0/legalcode.txt'],
    ['CC-BY-SA-4.0.txt', 'https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt'],
    ['GFDL-1.2.html', 'https://textbooks.math.gatech.edu/ila/appendix-gfdl.html'],
  ]) {
    const response = await page.request.get(url);
    if (!response.ok()) throw new Error(`License download failed: ${url} ${response.status()}`);
    const text = await response.text();
    if ((!file.endsWith('.html') && text.includes('<html')) || text.length < 5000)
      throw new Error(`Unexpected license document: ${url}`);
    await writeFile(corpusPath(`licenses/${file}`), text);
    console.log(file);
  }
} finally {
  await browser.close();
}
const notices = manifest.documents
  .map(
    (d) =>
      `${d.title}\nAuthors: ${Array.isArray(d.authors) ? d.authors.join(', ') : d.authors}\nSource: ${d.permalink ?? d.url}\nLicense: ${d.license}; ${d.articleLicenseUrl ?? d.licenseUrl}\n${d.copyrightNotice ? `${d.copyrightNotice}\n` : ''}${d.modifications.some((text) => text.includes('consent overlays')) ? 'Changes: Consent overlays and reveal modals hidden.\n' : ''}${d.publisher === 'ILA' ? 'GNU FDL 1.2 or later; no invariant sections, front-cover texts, or back-cover texts.\n' : ''}`,
  )
  .join('\n');
await writeFile(
  corpusPath('NOTICE.md'),
  `# Corpus source attribution\n\nLicense texts: licenses/. Source snapshots: sources/.\n\nChanges: Cropped without scaling; citation/edit controls, reference markers and equation labels removed where present. Details: manifest.json.\n\n${notices}`,
);
