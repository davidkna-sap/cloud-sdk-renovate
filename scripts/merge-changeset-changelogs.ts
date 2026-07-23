import { assembleReleasePlan } from '@changesets/assemble-release-plan';
import { readConfig } from '@changesets/config';
import { readChangesets } from '@changesets/read';
import type { NewChangeset, ReleasePlan } from '@changesets/types';
import { getPackages } from '@manypkg/get-packages';
import { execFile } from 'child_process';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';

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
const SUMMARY_CATEGORY = /^\[([^\]]+)\]\s+([\s\S]*)$/;
const execFileAsync = promisify(execFile);

function getCurrentRootVersion(rootChangelog: string): string {
  const match = rootChangelog.match(NEXT_VERSION_HEADING);

  if (!match) {
    throw new Error('Could not find the current version in CHANGELOG.md.');
  }

  return match[0].replace('# ', '');
}

function parseSummary(
  summary: string
): Pick<ChangelogEntry, 'category' | 'text'> {
  const match = summary.match(SUMMARY_CATEGORY);

  if (!match) {
    throw new Error(
      `Changeset summary must start with one of [compat], [feat], [fix] or [improvement]: ${summary}`
    );
  }

  const category = CATEGORY_BY_TAG[match[1].toLowerCase()];

  if (!category) {
    throw new Error(
      `Unsupported changeset category [${match[1]}]. Use [compat], [feat], [fix] or [improvement].`
    );
  }

  return {
    category,
    text: match[2].trim()
  };
}

async function getChangesetCommit(changesetId: string): Promise<string> {
  const { stdout } = await execFileAsync('git', [
    'log',
    '-n',
    '1',
    '--format=%h',
    '--',
    path.join('.changeset', `${changesetId}.md`)
  ]);
  const hash = stdout.trim();

  if (!hash) {
    throw new Error(
      `Could not resolve a commit for changeset: ${changesetId}. Fetch full git history before running this script.`
    );
  }

  return hash;
}

async function collectEntries(
  changesets: NewChangeset[]
): Promise<ChangelogEntry[]> {
  const entriesByKey = new Map<string, ChangelogEntry>();

  for (const changeset of changesets) {
    const { category, text } = parseSummary(changeset.summary);
    const hash = await getChangesetCommit(changeset.id);
    const packages = new Set(
      changeset.releases.map(release =>
        release.name.replace('@sap-ai-sdk/', '')
      )
    );
    const key = `${category}\0${hash}\0${text}`;
    const existingEntry = entriesByKey.get(key);

    if (existingEntry) {
      for (const packageName of packages) {
        existingEntry.packages.add(packageName);
      }
    } else {
      entriesByKey.set(key, { category, hash, packages, text });
    }
  }

  return [...entriesByKey.values()];
}

async function getReleasePlan(): Promise<ReleasePlan> {
  const packages = await getPackages(process.cwd());
  const configResult = await readConfig(process.cwd(), packages);

  if (configResult.errors) {
    throw new Error(configResult.errors.join('\n'));
  }

  const changesets = await readChangesets(process.cwd());

  return assembleReleasePlan(
    changesets,
    packages,
    configResult.config,
    undefined
  );
}

function getNextRootVersion(
  rootChangelog: string,
  releasePlan: ReleasePlan
): string {
  const currentRootVersion = getCurrentRootVersion(rootChangelog);
  const releaseVersions = releasePlan.releases
    .map(release => release.newVersion)
    .filter(version => version !== currentRootVersion);

  if (!releaseVersions.length) {
    throw new Error('Could not find a new package version for CHANGELOG.md.');
  }

  return releaseVersions.sort((a, b) =>
    b.localeCompare(a, undefined, {
      numeric: true
    })
  )[0];
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
  const releasePlan = await getReleasePlan();

  if (!releasePlan.changesets.length) {
    return;
  }

  const rootChangelog = await readFile('CHANGELOG.md', 'utf8');
  const version = getNextRootVersion(rootChangelog, releasePlan);
  const entries = await collectEntries(releasePlan.changesets);

  if (!entries.length) {
    throw new Error(`Could not find changelog entries for version ${version}.`);
  }

  const updatedRootChangelog = insertRootChangelogEntry(
    rootChangelog,
    version,
    entries
  );

  await writeFile('CHANGELOG.md', updatedRootChangelog);
}

await mergeChangesetChangelogs();
