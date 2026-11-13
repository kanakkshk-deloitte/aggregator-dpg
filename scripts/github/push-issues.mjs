#!/usr/bin/env node
// Push issues to GitHub based on the drafts under docs/issues/.
// - Epic files (docs/issues/**/P-*-<slug>.md, PH-*-<slug>.md, X-01-<slug>.md)
//   -> one "type:epic" issue each.
// - Feature/stub files (docs/issues/**/*-features.md, *-stubs.md)
//   -> one "type:feature" issue per H2 section.
//
// Runs idempotently by checking a local `.issue-map.json` that caches
// epic-slug / feature-key -> issue number after successful creation.
//
// Usage:
//   node scripts/github/push-issues.mjs [--repo sanketika-labs/aggregator-dpg] [--dry-run] [--limit N]

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);

const REPO = flag('--repo') ?? 'sanketika-labs/aggregator-dpg';
const DRY = has('--dry-run');
const LIMIT = flag('--limit') ? Number(flag('--limit')) : Infinity;
const MAP_PATH = 'scripts/github/.issue-map.json';
const ISSUES_DIR = 'docs/issues';

const issueMap = existsSync(MAP_PATH)
  ? JSON.parse(readFileSync(MAP_PATH, 'utf8'))
  : { epics: {}, features: {} };

function saveMap() {
  writeFileSync(MAP_PATH, JSON.stringify(issueMap, null, 2));
}

function gh(args, { capture = true } = {}) {
  if (DRY) {
    console.log(`  [DRY] gh ${args.slice(0, 200)}…`);
    return '';
  }
  const out = execSync(`gh ${args}`, {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  return capture ? out.trim() : '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// -------- Frontmatter parser (tiny, line-oriented) --------
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (/^\[.*\]$/.test(val)) {
      val = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      val = val.replace(/^["']|["']$/g, '');
    }
    meta[key] = val;
  }
  return { meta, body: m[2] };
}

// -------- File discovery --------
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) out.push(...walk(p));
    else if (name.isFile() && p.endsWith('.md')) out.push(p);
  }
  return out;
}

const allMd = walk(ISSUES_DIR);

// Epic files: anything that is NOT INDEX, README, -features, -stubs
const epicFiles = allMd.filter((p) => {
  const b = basename(p);
  if (b === 'INDEX.md' || b === 'README.md') return false;
  if (/-features\.md$/.test(b)) return false;
  if (/-stubs\.md$/.test(b)) return false;
  return true;
});

const featuresFiles = allMd.filter((p) => /-features\.md$/.test(basename(p)));
const stubsFiles = allMd.filter((p) => /-stubs\.md$/.test(basename(p)));

// -------- Issue creation --------
function createIssue({ title, body, labels = [], milestone }) {
  const tmp = join(tmpdir(), `issue-${process.pid}-${Date.now()}-${randomUUID()}.md`);
  writeFileSync(tmp, body);
  const labelArgs = labels.map((l) => `--label "${l}"`).join(' ');
  const milestoneArg = milestone ? `--milestone "${milestone}"` : '';
  // Escape for double-quoted shell: backslash, backtick, dollar, double-quote
  const titleEsc = title
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('`', String.raw`\``)
    .replaceAll('$', String.raw`\$`)
    .replaceAll('"', String.raw`\"`);
  const url = gh(
    `issue create --repo ${REPO} --title "${titleEsc}" --body-file "${tmp}" ${labelArgs} ${milestoneArg}`,
  );
  const m = url.match(/\/issues\/(\d+)/);
  if (!m && !DRY) throw new Error(`Could not parse issue URL: ${url}`);
  return { number: DRY ? 0 : Number(m[1]), url };
}

function addToProject(issueUrl) {
  // Load project meta (optional)
  if (!existsSync('scripts/github/.project.json')) return;
  const project = JSON.parse(readFileSync('scripts/github/.project.json', 'utf8'));
  gh(`project item-add ${project.number} --owner ${project.owner} --url "${issueUrl}"`);
}

function addSubIssue(parentNumber, childNumber) {
  if (DRY) {
    console.log(`  [DRY] link sub-issue ${childNumber} -> parent ${parentNumber}`);
    return;
  }
  const parentId = JSON.parse(gh(`issue view ${parentNumber} --repo ${REPO} --json id`)).id;
  const childId = JSON.parse(gh(`issue view ${childNumber} --repo ${REPO} --json id`)).id;
  const mutation = `mutation{addSubIssue(input:{issueId:"${parentId}",subIssueId:"${childId}"}){issue{number}}}`;
  try {
    gh(`api graphql -f query='${mutation}'`);
  } catch (e) {
    console.warn(
      `  sub-issue link failed for ${childNumber} -> ${parentNumber}: ${e.message?.slice(0, 200) ?? e}`,
    );
  }
}

// -------- Key derivation (P-01, PH-1, X-01) --------
function epicKeyFromFile(file) {
  const b = basename(file);
  const m = b.match(/^(P-\d+|PH-\d+|X-\d+)/);
  if (!m) throw new Error(`Can't derive epic key from ${file}`);
  return m[1];
}
function epicKeyFromFeaturesFile(file) {
  // P-03-features.md -> P-03 ; PH-1-features.md -> PH-1 ; X-01-stubs.md -> X-01
  return basename(file).replace(/-(features|stubs)\.md$/, '');
}

// -------- Pass 1: epics --------
let count = 0;
for (const file of epicFiles) {
  if (count >= LIMIT) break;
  const key = epicKeyFromFile(file);
  if (issueMap.epics[key]) {
    console.log(`epic ${key} already pushed as #${issueMap.epics[key]}; skipping`);
    continue;
  }
  const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'));
  const title = meta.title ?? `[EPIC] ${key}`;
  const labels = Array.isArray(meta.labels) ? meta.labels : [];
  const milestone = meta.milestone;
  console.log(`Creating epic ${key}: ${title}`);
  const { number, url } = createIssue({ title, body, labels, milestone });
  issueMap.epics[key] = number;
  saveMap();
  if (!DRY && url) {
    try {
      addToProject(url);
    } catch (e) {
      console.warn(`  project add failed: ${e.message?.slice(0, 200)}`);
    }
  }
  await sleep(600);
  count++;
}

// -------- Pass 2: features from *-features.md and *-stubs.md --------
function splitH2Sections(body) {
  // Splits at ^## lines. Preserves heading line. Skips any preamble before
  // the first ##.
  const sections = [];
  const lines = body.split(/\r?\n/);
  let current = null;
  for (const ln of lines) {
    if (/^## /.test(ln)) {
      if (current) sections.push(current);
      current = { heading: ln.replace(/^## /, '').trim(), content: [ln] };
    } else if (current) {
      current.content.push(ln);
    }
  }
  if (current) sections.push(current);
  return sections.map((s) => ({
    heading: s.heading,
    body: s.content.join('\n').trim(),
  }));
}

function featureLabelsFromEpic(epicKey, epicLabels) {
  // Replace epic label with feature label; preserve phase/area/jtbd/priority.
  const labels = (epicLabels ?? []).filter((l) => l !== 'type:epic');
  if (!labels.includes('type:feature')) labels.unshift('type:feature');
  return labels;
}

for (const file of [...featuresFiles, ...stubsFiles]) {
  if (count >= LIMIT) break;
  const epicKey = epicKeyFromFeaturesFile(file);
  const parentNumber = issueMap.epics[epicKey];
  if (!parentNumber) {
    console.warn(`No parent epic issue for ${epicKey}; skipping ${file}`);
    continue;
  }

  // Load epic meta to inherit labels / milestone
  const epicFile = epicFiles.find((f) => epicKeyFromFile(f) === epicKey);
  if (!epicFile) {
    console.warn(`Cannot find epic file for ${epicKey}; skipping ${file}`);
    continue;
  }
  const epicMeta = parseFrontmatter(readFileSync(epicFile, 'utf8')).meta;
  const inheritedLabels = featureLabelsFromEpic(epicKey, epicMeta.labels);
  const milestone = epicMeta.milestone;

  const body = readFileSync(file, 'utf8');
  const sections = splitH2Sections(body);
  console.log(`\n${epicKey}: ${sections.length} sections in ${basename(file)}`);

  for (const section of sections) {
    if (count >= LIMIT) break;
    const key = `${epicKey}::${section.heading}`;
    if (issueMap.features[key]) {
      console.log(`  feature already pushed as #${issueMap.features[key]}: ${section.heading}`);
      continue;
    }

    // Build title
    const headingForTitle = section.heading.replace(/^Φ\d+ /, '').trim();
    const title = `[FEAT] ${headingForTitle}`;

    // Build body — append a parent-epic pointer
    const finalBody = `${section.body}\n\n---\n**Parent epic:** #${parentNumber} (${epicKey})\n`;

    console.log(`  creating: ${title}`);
    const { number, url } = createIssue({
      title,
      body: finalBody,
      labels: inheritedLabels,
      milestone,
    });
    issueMap.features[key] = number;
    saveMap();

    if (!DRY && url) {
      try {
        addToProject(url);
      } catch (e) {
        console.warn(`    project add failed: ${e.message?.slice(0, 200)}`);
      }
      addSubIssue(parentNumber, number);
    }
    await sleep(700);
    count++;
  }
}

console.log(
  `\nDone. Epics: ${Object.keys(issueMap.epics).length}. Features: ${Object.keys(issueMap.features).length}. ${DRY ? '(dry-run)' : ''}`,
);
