import { readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';

type Category =
  'Compatibility Notes' | 'New Features' | 'Fixed Issues' | 'Improvements';

interface ChangelogEntry {
  category: Category;
  hash: string;
  packages: Set<string>;
  text: string;
}

const CATEGORY_ORDER: Category[] = [
  'Compatibility Notes',
  'New Features',
  'Fixed Issues',
  'Improvements'
];

const CATEGORY_BY_TAG: Record<string, Category> = {
  compat: 'Compatibility Notes',
  feat: 'New Features',
  fix: 'Fixed Issues',
  improvement: 'Improvements'
};

const NEXT_VERSION_HEADING = /^# \d+\.\d+\.\d+$/m;

async function getPackageNames(): Promise<string[]> {
  const packagesDir = 'packages';
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const packageNames = await Promise.all(
    entries
      .filter(entry => entry.isDirectory())
      .map(async entry => {
        const packageJsonPath = path.join(
          packagesDir,
          entry.name,
          'package.json'
        );
        const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
        return packageJson.name as string;
      })
  );

  return packageNames.sort();
}

function getVersionSection(
  changelog: string,
  version: string
): string | undefined {
  const versionHeading = `## ${version}`;
  const start = changelog.indexOf(versionHeading);

  if (start === -1) {
    return undefined;
  }

  const sectionStart = start + versionHeading.length;
  const nextVersionStart = changelog.slice(sectionStart).search(/^## \d/m);

  if (nextVersionStart === -1) {
    return changelog.slice(sectionStart);
  }

  return changelog.slice(sectionStart, sectionStart + nextVersionStart);
}

function getBullets(section: string): string[] {
  const bullets: string[] = [];
  let currentBullet: string[] = [];

  for (const line of section.split('\n')) {
    if (line.startsWith('- ')) {
      if (currentBullet.length) {
        bullets.push(currentBullet.join('\n'));
      }
      currentBullet = [line];
      continue;
    }

    if (currentBullet.length && !line.startsWith('### ')) {
      currentBullet.push(line);
    }
  }

  if (currentBullet.length) {
    bullets.push(currentBullet.join('\n'));
  }

  return bullets;
}

function parseBullet(
  packageName: string,
  bullet: string
): ChangelogEntry | undefined {
  if (bullet.startsWith('- Updated dependencies')) {
    return undefined;
  }

  const match = bullet.match(/^- ([0-9a-f]{7,40}): \[([^\]]+)\] (.*)$/s);
  if (!match) {
    return undefined;
  }

  const [, hash, tag, text] = match;
  const category = CATEGORY_BY_TAG[tag.toLowerCase()];

  if (!category) {
    return undefined;
  }

  return {
    category,
    hash,
    packages: new Set([packageName.replace('@sap-ai-sdk/', '')]),
    text: text.trimEnd()
  };
}

async function collectEntries(version: string): Promise<ChangelogEntry[]> {
  const packageNames = await getPackageNames();
  const entriesByKey = new Map<string, ChangelogEntry>();

  for (const packageName of packageNames) {
    const packageDir = packageName.replace('@sap-ai-sdk/', '');
    const changelogPath = path.join('packages', packageDir, 'CHANGELOG.md');
    const changelog = await readFile(changelogPath, 'utf8');
    const section = getVersionSection(changelog, version);

    if (!section) {
      continue;
    }

    for (const bullet of getBullets(section)) {
      const entry = parseBullet(packageName, bullet);

      if (!entry) {
        continue;
      }

      const key = `${entry.category}\0${entry.hash}\0${entry.text}`;
      const existingEntry = entriesByKey.get(key);

      if (existingEntry) {
        existingEntry.packages.add([...entry.packages][0]);
      } else {
        entriesByKey.set(key, entry);
      }
    }
  }

  return [...entriesByKey.values()];
}

function formatEntry(entry: ChangelogEntry): string {
  const packages = [...entry.packages].sort().join(', ');
  const [firstLine, ...remainingLines] = entry.text.split('\n');
  const continuation = remainingLines.length
    ? `\n${remainingLines.join('\n')}`
    : '';

  return `- [${packages}] ${firstLine} (${entry.hash})${continuation}`;
}

function formatRootChangelogEntry(
  version: string,
  entries: ChangelogEntry[]
): string {
  const sections = CATEGORY_ORDER.map(category => {
    const categoryEntries = entries.filter(
      entry => entry.category === category
    );

    if (!categoryEntries.length) {
      return undefined;
    }

    return [`## ${category}`, ...categoryEntries.map(formatEntry)].join('\n\n');
  }).filter(Boolean);

  return [`# ${version}`, ...sections].join('\n');
}

function insertRootChangelogEntry(
  rootChangelog: string,
  version: string,
  entries: ChangelogEntry[]
): string {
  const nextVersionMatch = rootChangelog.match(NEXT_VERSION_HEADING);

  if (nextVersionMatch?.index === undefined) {
    throw new Error(
      'Could not find the first released version in CHANGELOG.md.'
    );
  }

  const newEntry = formatRootChangelogEntry(version, entries);
  const beforeVersions = rootChangelog
    .slice(0, nextVersionMatch.index)
    .trimEnd();
  const existingVersions = rootChangelog
    .slice(nextVersionMatch.index)
    .trimStart();

  return `${beforeVersions}\n\n${newEntry}\n\n${existingVersions}`;
}

async function mergeChangesetChangelogs(): Promise<void> {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  const version = packageJson.version as string;
  const entries = await collectEntries(version);

  if (!entries.length) {
    throw new Error(`Could not find changelog entries for version ${version}.`);
  }

  const rootChangelog = await readFile('CHANGELOG.md', 'utf8');
  const updatedRootChangelog = insertRootChangelogEntry(
    rootChangelog,
    version,
    entries
  );

  await writeFile('CHANGELOG.md', updatedRootChangelog);
}

await mergeChangesetChangelogs();
