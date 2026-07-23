const CATEGORY_LABELS = {
  compat: 'compat',
  feat: 'feat',
  fix: 'fix',
  improvement: 'improvement'
};

const CATEGORY_ALIASES = {
  breaking: 'compat',
  compatibility: 'compat',
  feature: 'feat',
  improvements: 'improvement',
  perf: 'improvement'
};

function normalizeCategory(category) {
  const normalizedCategory = category.toLowerCase().trim();

  return (
    CATEGORY_LABELS[normalizedCategory] ?? CATEGORY_ALIASES[normalizedCategory]
  );
}

function parseSummary(summary) {
  const match = summary.match(/^\[([^\]]+)\]\s+([\s\S]*)$/);

  if (!match) {
    throw new Error(
      `Changeset summary must start with one of [compat], [feat], [fix] or [improvement]: ${summary}`
    );
  }

  const category = normalizeCategory(match[1]);

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

async function getReleaseLine(changeset) {
  const { category, text } = parseSummary(changeset.summary);

  if (!changeset.commit) {
    throw new Error(
      'Changesets could not resolve a commit for this changeset. Fetch full git history before running `changeset version`.'
    );
  }

  return `- ${changeset.commit.slice(0, 7)}: [${category}] ${text}`;
}

async function getDependencyReleaseLine(changesets, dependenciesUpdated) {
  if (!dependenciesUpdated.length) {
    return '';
  }

  const changesetCommits = changesets
    .map(changeset => changeset.commit)
    .filter(Boolean);
  const commitSuffix = changesetCommits.length
    ? ` [${changesetCommits.join(', ')}]`
    : '';
  const dependencyLines = dependenciesUpdated.map(
    dependency => `  - ${dependency.name}@${dependency.newVersion}`
  );

  return [`- Updated dependencies${commitSuffix}`, ...dependencyLines].join(
    '\n'
  );
}

module.exports = {
  getDependencyReleaseLine,
  getReleaseLine
};
