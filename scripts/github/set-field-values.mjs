#!/usr/bin/env node
// Set Phase / Area / Priority / JTBD / Epic field values on every project
// item, inferring from the issue's labels and the issue-map cache.
//
// Idempotent — re-running just overwrites with the same values.
//
// Usage: node scripts/github/set-field-values.mjs [--owner sanketika-labs] [--project 3]

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const OWNER = flag('--owner') ?? 'sanketika-labs';
const PROJECT_NUMBER = Number(flag('--project') ?? 3);
const MAP_PATH = 'scripts/github/.issue-map.json';

if (!existsSync(MAP_PATH)) {
  console.error(`Missing ${MAP_PATH}; run push-issues.mjs first.`);
  process.exit(1);
}
const issueMap = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
const epicByNumber = Object.fromEntries(
  Object.entries(issueMap.epics).map(([key, num]) => [num, key]),
);

// reverse-lookup "feature number -> epic key"
const featureToEpic = {};
for (const [compoundKey, featureNum] of Object.entries(issueMap.features)) {
  const epicKey = compoundKey.split('::')[0];
  featureToEpic[featureNum] = epicKey;
}

function gh(cmd, { parse = true } = {}) {
  const out = execSync(`gh ${cmd}`, { encoding: 'utf8' });
  return parse ? JSON.parse(out) : out.trim();
}

function graphqlInline(query) {
  // Write query to a tempfile and pass via --field query=@file to avoid shell escaping.
  const tmp = `/tmp/gql-${process.pid}-${Date.now()}.graphql`;
  execSync(`cat > ${tmp}`, { input: query });
  const out = execSync(`gh api graphql -F query=@${tmp}`, { encoding: 'utf8' });
  execSync(`rm -f ${tmp}`);
  return JSON.parse(out);
}

// -------- Fetch project metadata --------
console.log(`Fetching project metadata for ${OWNER}/#${PROJECT_NUMBER} …`);
const projectMeta = graphqlInline(
  `{
    organization(login:"${OWNER}"){
      projectV2(number:${PROJECT_NUMBER}){
        id title
        fields(first:30){
          nodes{
            __typename
            ... on ProjectV2Field { id name dataType }
            ... on ProjectV2SingleSelectField {
              id name dataType
              options { id name }
            }
          }
        }
      }
    }
  }`,
);

const project = projectMeta.data.organization.projectV2;
if (!project) {
  console.error('Project not found');
  process.exit(1);
}
const fields = {};
for (const f of project.fields.nodes) {
  fields[f.name] = f;
}

function optionId(fieldName, optionName) {
  const f = fields[fieldName];
  if (!f?.options) return null;
  const opt = f.options.find((o) => o.name === optionName);
  return opt?.id ?? null;
}

// -------- Fetch all project items --------
console.log('Fetching all project items (may take a moment) …');
async function fetchAllItems() {
  let items = [];
  let cursor = null;
  while (true) {
    const cursorArg = cursor ? `, after: "${cursor}"` : '';
    const q = `{
      organization(login: "${OWNER}") {
        projectV2(number: ${PROJECT_NUMBER}) {
          items(first: 100${cursorArg}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              content {
                __typename
                ... on Issue {
                  number
                  title
                  labels(first: 30) { nodes { name } }
                }
              }
            }
          }
        }
      }
    }`;
    const res = graphqlInline(q);
    const page = res.data.organization.projectV2.items;
    items.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return items;
}

const items = await fetchAllItems();
console.log(`Found ${items.length} items.`);

// -------- Derive field values from labels --------
function deriveValues(labels) {
  const set = new Set(labels);
  const out = {};

  // Phase
  const phaseLabel = labels.find((l) => l.startsWith('phase:'));
  if (phaseLabel) {
    const raw = phaseLabel.slice('phase:'.length);
    out.Phase = raw === 'post-mvp' ? 'Post-MVP' : raw;
  }

  // Area — pick the first area: label; issues may have multiple. Area field
  // is single-select, so we pick one. If multiple, prefer a conventional
  // precedence: backend > frontend > db > auth > observability > security >
  // sps > config > qa > devex.
  const areaPref = [
    'backend',
    'frontend',
    'db',
    'auth',
    'observability',
    'security',
    'sps',
    'config',
    'qa',
    'devex',
  ];
  const areaLabels = labels
    .filter((l) => l.startsWith('area:'))
    .map((l) => l.slice('area:'.length));
  for (const pref of areaPref) {
    if (areaLabels.includes(pref)) {
      out.Area = pref;
      break;
    }
  }

  // Priority
  const priorityLabel = labels.find((l) => l.startsWith('priority:'));
  if (priorityLabel) {
    out.Priority = priorityLabel.slice('priority:'.length).toUpperCase();
  }

  // JTBD — concat all jtbd: labels
  const jtbds = labels.filter((l) => l.startsWith('jtbd:')).map((l) => l.slice('jtbd:'.length));
  if (jtbds.length) out.JTBD = jtbds.join(', ');

  return out;
}

// -------- Field update mutation --------
function updateSingleSelect(itemId, fieldName, optionName) {
  const fieldId = fields[fieldName]?.id;
  if (!fieldId) return false;
  const optId = optionId(fieldName, optionName);
  if (!optId) {
    console.warn(`  option "${optionName}" not found on field "${fieldName}"`);
    return false;
  }
  const m = `mutation{updateProjectV2ItemFieldValue(input:{projectId:"${project.id}",itemId:"${itemId}",fieldId:"${fieldId}",value:{singleSelectOptionId:"${optId}"}}){projectV2Item{id}}}`;
  gh(`api graphql -f query='${m}'`, { parse: false });
  return true;
}

function updateText(itemId, fieldName, text) {
  const fieldId = fields[fieldName]?.id;
  if (!fieldId) return false;
  const escaped = text.replaceAll('"', String.raw`\"`);
  const m = `mutation{updateProjectV2ItemFieldValue(input:{projectId:"${project.id}",itemId:"${itemId}",fieldId:"${fieldId}",value:{text:"${escaped}"}}){projectV2Item{id}}}`;
  gh(`api graphql -f query='${m}'`, { parse: false });
  return true;
}

// -------- Iterate items --------
let n = 0;
let errors = 0;
for (const item of items) {
  if (item.content?.__typename !== 'Issue') continue;
  const issueNum = item.content.number;
  const labels = item.content.labels?.nodes?.map((l) => l.name) ?? [];
  const vals = deriveValues(labels);

  try {
    if (vals.Phase) updateSingleSelect(item.id, 'Phase', vals.Phase);
    if (vals.Area) updateSingleSelect(item.id, 'Area', vals.Area);
    if (vals.Priority) updateSingleSelect(item.id, 'Priority', vals.Priority);
    if (vals.JTBD) updateText(item.id, 'JTBD', vals.JTBD);

    // Epic: epic issues set to their own key; features set to their parent epic key
    const epicKey = epicByNumber[issueNum] ?? featureToEpic[issueNum];
    if (epicKey) updateSingleSelect(item.id, 'Epic', epicKey);
  } catch (e) {
    errors++;
    console.warn(`  #${issueNum}: ${e.message?.slice(0, 200) ?? e}`);
  }

  n++;
  if (n % 20 === 0) console.log(`  ${n}/${items.length} …`);
}

console.log(`\nDone. Updated ${n} items. Errors: ${errors}.`);
