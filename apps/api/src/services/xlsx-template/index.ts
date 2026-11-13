/**
 * XLSX bulk-upload template generator for `@aggregator-dpg/api`.
 *
 * Builds a workbook an operator fills in and exports with File > Save As > CSV.
 * It shows which columns are required, which values a closed set accepts, and
 * how array cells are joined. Uploads still accept `.csv` only.
 *
 * ## One workbook per participant type, four tabs
 *
 * ```
 * 1. Instructions        what to do, and the legend for the colours
 * 2. Allowed values      every column, closed sets first, with its label
 * 3. Sample data         worked rows covering every conditional branch
 * 4. Enter your <type>s  the empty grid to fill, with the dropdowns
 * ```
 *
 * ## Grid headers are field names
 *
 * The parser (`bulk-file-stream`) matches the CSV header on field names, so the
 * grid's header row is field names and is the only row above the data. Human
 * labels appear on tabs 2 and 3 and in each header cell's note.
 *
 * ## Generated from the schema
 *
 * Every column, dropdown and sample row comes from the schema resolved from
 * `network.json` at boot, so the template matches what the parser accepts.
 *
 * @module apps/api/services/xlsx-template
 */

import ExcelJS from 'exceljs';
import type { JsonSchema } from '@aggregator-dpg/schema-loader/interface';
import {
  exampleValue,
  identityExample,
  orderedColumns,
  wellKnownExample,
} from '../csv-template/index.js';
import { wellKnownColumnMeta } from '@aggregator-dpg/shared-primitives/bulk-columns';

/** Tab 1: what to do. */
const INSTRUCTIONS_SHEET = '1. Instructions';
/** Tab 2: the closed sets, then every remaining column. */
const VALUES_SHEET = '2. Allowed values';
/** Tab 3: worked examples. */
const SAMPLE_SHEET = '3. Sample data';
/** Hidden sheet holding the dropdown value ranges. Hidden so operators do not edit them. */
const LISTS_SHEET = 'Lists';
/** Rows the grid carries validation for. */
const VALIDATED_ROWS = 500;
/** Upper bound on sample rows, applied after duplicates are dropped. */
const MAX_SAMPLE_ROWS = 14;
/** Excel's hard limit on a worksheet name. */
const SHEET_NAME_MAX = 31;

/** Header fill for a required column. */
const FILL_REQUIRED = 'FFFDE68A';
/** Header fill for a column that only applies in some cases. */
const FILL_CONDITIONAL = 'FFE2E8F0';
/** Header fill for an ordinary optional column. */
const FILL_OPTIONAL = 'FFF8FAFC';
/** Tab colours. */
const TAB_COLOURS = {
  instructions: 'FF94A3B8',
  values: 'FF60A5FA',
  sample: 'FFFBBF24',
  grid: 'FF34D399',
} as const;

/** Sheet name for the fill-in grid, e.g. `4. Enter your seekers`. */
function gridSheetName(participantType: string): string {
  const plural = participantType.endsWith('s') ? participantType : `${participantType}s`;
  const full = `4. Enter your ${plural.replaceAll('_', ' ')}`;
  return full.length <= SHEET_NAME_MAX ? full : '4. Enter your rows';
}

export interface XlsxTemplateOptions {
  /**
   * Delimiter for array-typed cells, from the network's `csv_array_delimiter`.
   * Shown on tab 2 and used in the sample rows.
   */
  arrayDelimiter?: string;
  /**
   * The domain's identity selectors (`ResolvedDomain.identity`), naming the
   * name, phone and email columns. Used only to make those sample cells valid.
   */
  identity?: { name: string; phone: string; email?: string | undefined } | undefined;
}

interface ColumnPlan {
  name: string;
  /**
   * The property's own schema fragment, kept as-is so `exampleValue` sees what
   * the CSV generator sees.
   */
  prop: Record<string, unknown>;
  /** Human label from the schema's `title`, falling back to the field name. */
  label: string;
  required: boolean;
  /** Closed value set, from `enum` or `items.enum`. */
  allowed: string[];
  isArray: boolean;
  /**
   * Parsed `x-show-if` clauses, one per controller field, ANDed together.
   * Empty when the column always applies.
   */
  showIf: readonly ShowIfClause[];
  /** True when the rule can never be satisfied, so the column is never shown. */
  showIfNeverApplies: boolean;
  description?: string;
}

/** One clause: a controller field and the values that reveal this column. */
interface ShowIfClause {
  field: string;
  /** Controller values that make the column apply; empty means "any value". */
  values: string[];
}

/**
 * True when a column does not apply to every row.
 *
 * @param plan - The column.
 * @returns `true` when the column is conditional in any way.
 */
function isConditional(plan: ColumnPlan): boolean {
  return plan.showIf.length > 0 || plan.showIfNeverApplies;
}

/**
 * Parses the custom `x-show-if` keyword the same way the form renderer does.
 *
 * Matches `isFieldVisible` in `apps/web/src/lib/show-if.ts`: every entry must
 * hold (AND across keys), and a non-array `allowed` hides the field for good.
 * Keep the two in sync.
 *
 * Like the form, this ignores `allOf` / `if` / `then`; only `x-show-if` is read.
 *
 * @param rule - The property's `x-show-if` value, whatever shape it has.
 * @returns The ANDed clauses, and whether the rule can ever be satisfied.
 */
function parseShowIf(rule: unknown): { clauses: ShowIfClause[]; neverApplies: boolean } {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    return { clauses: [], neverApplies: false };
  }
  const clauses: ShowIfClause[] = [];
  for (const [field, allowed] of Object.entries(rule as Record<string, unknown>)) {
    // `isFieldVisible` returns false outright for a non-array `allowed`.
    if (!Array.isArray(allowed)) return { clauses: [], neverApplies: true };
    clauses.push({ field, values: allowed.map(String) });
  }
  return { clauses, neverApplies: false };
}

/**
 * Reads a property into the facts the workbook needs.
 *
 * @param name - Property name.
 * @param prop - The property's schema fragment.
 * @param required - Whether the schema lists it as required.
 * @returns Plan for one column.
 */
function planColumn(name: string, prop: Record<string, unknown>, required: boolean): ColumnPlan {
  const items = prop['items'] as Record<string, unknown> | undefined;
  const ownEnum = Array.isArray(prop['enum']) ? (prop['enum'] as unknown[]) : undefined;
  const itemEnum = Array.isArray(items?.['enum']) ? (items?.['enum'] as unknown[]) : undefined;
  const showIf = parseShowIf(prop['x-show-if']);

  const plan: ColumnPlan = {
    name,
    prop,
    label: typeof prop['title'] === 'string' ? (prop['title'] as string) : name,
    required,
    allowed: (ownEnum ?? itemEnum ?? []).map(String),
    isArray: prop['type'] === 'array',
    showIf: showIf.clauses,
    showIfNeverApplies: showIf.neverApplies,
  };

  if (typeof prop['description'] === 'string') plan.description = prop['description'] as string;
  return plan;
}

/**
 * Renders the "only fill in when" sentence for a conditional column.
 *
 * Multi-clause rules are joined with "and", as the form applies them.
 *
 * @param plan - The column.
 * @param byName - Every column by field name, for the controller's label.
 * @returns The sentence, or `''` when the column always applies.
 */
function onlyWhen(plan: ColumnPlan, byName: ReadonlyMap<string, ColumnPlan>): string {
  if (plan.showIfNeverApplies) return 'Never — leave this blank';
  if (plan.showIf.length === 0) return '';
  const clause = ({ field, values }: ShowIfClause): string => {
    const controller = byName.get(field)?.label ?? field;
    return values.length === 0
      ? `"${controller}" is filled in`
      : `"${controller}" is ${values.join(' or ')}`;
  };
  return `Only when ${plan.showIf.map(clause).join(' and ')}`;
}

/**
 * Lowercases only the first character, so a sentence can be spliced mid-line.
 *
 * @param text - Sentence to splice.
 * @returns The sentence with a lowercase lead-in.
 */
function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}

/**
 * Builds the XLSX bulk-upload template for one participant type.
 *
 * @param schema - Participant JSON Schema (object-typed, draft 2020-12).
 * @param participantType - Domain id, used in the sheet + column naming.
 * @param options - Array delimiter and identity selectors.
 * @returns The workbook as a buffer, ready to send as an attachment.
 */
export async function buildXlsxTemplate(
  schema: JsonSchema,
  participantType: string,
  options: XlsxTemplateOptions = {},
): Promise<Buffer> {
  const { arrayDelimiter = '|', identity } = options;

  const properties = (schema['properties'] as Record<string, Record<string, unknown>>) ?? {};
  const required = new Set(
    Array.isArray(schema['required']) ? (schema['required'] as string[]) : [],
  );
  // Well-known columns have no schema fragment; take title and description from shared metadata.
  const plans = orderedColumns(schema).map((name) => {
    const meta = wellKnownColumnMeta(name);
    const prop =
      properties[name] ?? (meta ? { title: meta.title, description: meta.description } : {});
    return planColumn(name, prop, required.has(name));
  });
  const byName = new Map(plans.map((p) => [p.name, p]));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Blue Dots Aggregator';
  wb.created = new Date();

  const gridName = gridSheetName(participantType);
  writeInstructions(wb, participantType, plans, byName, gridName, arrayDelimiter);

  const lists = wb.addWorksheet(LISTS_SHEET);
  const ranges = writeLists(lists, plans);
  lists.state = 'veryHidden';

  writeValuesSheet(wb, plans, byName, arrayDelimiter);
  writeSampleSheet(wb, plans, arrayDelimiter, identity);
  writeGridSheet(wb, gridName, plans, byName, ranges, arrayDelimiter);

  // Open on the grid: Save As CSV exports the active sheet.
  wb.views = [
    {
      activeTab: wb.worksheets.findIndex((sheet) => sheet.name === gridName),
      firstSheet: 0,
      visibility: 'visible',
      x: 0,
      y: 0,
      width: 28000,
      height: 18000,
    },
  ];

  // exceljs types its own `Buffer`; the value is a Node Buffer.
  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}

/**
 * Writes tab 1: what to do, plus the legend the other tabs' colours refer to.
 *
 * @param wb - Target workbook.
 * @param participantType - Domain id.
 * @param plans - Column plans.
 * @param byName - Columns by field name.
 * @param gridName - Name of the fill-in sheet, quoted in the steps.
 * @param arrayDelimiter - Delimiter for array cells.
 */
function writeInstructions(
  wb: ExcelJS.Workbook,
  participantType: string,
  plans: readonly ColumnPlan[],
  byName: ReadonlyMap<string, ColumnPlan>,
  gridName: string,
  arrayDelimiter: string,
): void {
  const sheet = wb.addWorksheet(INSTRUCTIONS_SHEET);
  sheet.properties.tabColor = { argb: TAB_COLOURS.instructions };
  sheet.getColumn(1).width = 4;
  sheet.getColumn(2).width = 112;

  /** Adds a row in the text column, returning it for styling. */
  const line = (text = '', indent = 2): ExcelJS.Row => {
    const row = sheet.addRow(indent === 1 ? [text] : ['', text]);
    row.getCell(indent).alignment = { wrapText: true, vertical: 'top' };
    return row;
  };

  const title = line(`Bulk upload — ${participantType.replaceAll('_', ' ')}`);
  title.font = { bold: true, size: 16 };
  line('Fill this in, save it as CSV, and upload the CSV to the portal.').font = {
    color: { argb: 'FF475569' },
  };
  line();

  line('Steps').font = { bold: true, size: 12 };
  const requiredLabels = plans.filter((p) => p.required).map((p) => `"${p.label}"`);
  for (const step of [
    `1. Open "${SAMPLE_SHEET}" and look at how a row is filled in. Those rows are examples, not participants — come back to "${gridName}" before you save.`,
    `2. Type your own rows in "${gridName}", one participant per row. Start on row 2.`,
    `3. Cells with a dropdown arrow only accept the listed values. Click the arrow and pick one.`,
    `4. Leave anything you do not have blank. Only ${requiredLabels.join(' and ') || 'the marked columns'} must be filled for every row.`,
    `5. Check "${VALUES_SHEET}" whenever you are unsure what a column wants.`,
    `6. Save as CSV: File > Save As (or Export) > CSV. This exports only the tab you are on, so be on "${gridName}" — saving from "${SAMPLE_SHEET}" would upload the examples.`,
  ]) {
    line(step);
  }
  line();

  line('What the colours mean').font = { bold: true, size: 12 };
  const legend: Array<[string, string]> = [
    [FILL_REQUIRED, 'Must be filled in for every row.'],
    [FILL_CONDITIONAL, 'Only applies in some cases — the column heading says when. Usually blank.'],
    [FILL_OPTIONAL, 'Optional. Fill it in if you have it; a fuller row matches better.'],
  ];
  for (const [argb, text] of legend) {
    const row = line(text);
    const swatch = row.getCell(1);
    swatch.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
    swatch.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
  }
  line();

  line('Good to know').font = { bold: true, size: 12 };
  const multi = plans.filter((p) => p.isArray);
  if (multi.length > 0) {
    line(
      `• ${multi.length} column${multi.length === 1 ? '' : 's'} take more than one value. Join them with "${arrayDelimiter}" in the same cell — for example: ${exampleValue(multi[0]!.name, multi[0]!.prop, arrayDelimiter)}`,
    );
  }
  const conditional = plans.filter(isConditional);
  if (conditional.length > 0) {
    const example = conditional[0]!;
    line(
      `• ${conditional.length} of the ${plans.length} columns only apply in some cases. Example: "${example.label}" — ${lowerFirst(onlyWhen(example, byName))}.`,
    );
  }
  line('• Hover over any column heading for a short explanation of that column.');
  line('• Do not rename, reorder or delete the heading row — the upload matches on it.');
  line('• Row 1 must stay exactly as it is. Your data starts on row 2.');
}

/**
 * Writes one hidden column of allowed values per closed-set field.
 *
 * Every dropdown is range-backed, since Excel caps an inline list at 255 characters.
 *
 * @param sheet - The hidden lists sheet.
 * @param plans - Column plans.
 * @returns Absolute range formula per column name.
 */
function writeLists(
  sheet: ExcelJS.Worksheet,
  plans: readonly ColumnPlan[],
): ReadonlyMap<string, string> {
  const ranges = new Map<string, string>();
  let col = 1;
  for (const plan of plans) {
    if (plan.allowed.length === 0) continue;
    const letter = columnLetter(col);
    sheet.getCell(1, col).value = plan.name;
    plan.allowed.forEach((value, i) => {
      sheet.getCell(i + 2, col).value = value;
    });
    ranges.set(plan.name, `'${LISTS_SHEET}'!$${letter}$2:$${letter}$${plan.allowed.length + 1}`);
    col += 1;
  }
  return ranges;
}

/**
 * Writes tab 2: one row per column, closed sets first.
 *
 * Free-text columns follow, so the tab lists every grid column.
 *
 * @param wb - Target workbook.
 * @param plans - Column plans.
 * @param byName - Columns by field name.
 * @param arrayDelimiter - Delimiter for array cells.
 */
function writeValuesSheet(
  wb: ExcelJS.Workbook,
  plans: readonly ColumnPlan[],
  byName: ReadonlyMap<string, ColumnPlan>,
  arrayDelimiter: string,
): void {
  const sheet = wb.addWorksheet(VALUES_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.properties.tabColor = { argb: TAB_COLOURS.values };
  sheet.columns = [
    { header: 'Column heading in the grid', key: 'name', width: 34 },
    { header: 'What it means', key: 'label', width: 30 },
    { header: 'Must fill?', key: 'required', width: 11 },
    { header: 'More than one?', key: 'multi', width: 16 },
    { header: 'Only fill in when', width: 40, key: 'when' },
    { header: 'Accepted values', key: 'allowed', width: 70 },
  ];
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.height = 24;
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0EAFF' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });

  const closed = plans.filter((p) => p.allowed.length > 0);
  const free = plans.filter((p) => p.allowed.length === 0);

  /** Adds one column's row, shaded to match the grid's header colour. */
  const addRow = (plan: ColumnPlan): void => {
    // Use the array delimiter only for multi-value columns; otherwise commas.
    const separator = plan.isArray ? `${arrayDelimiter} ` : ', ';
    const row = sheet.addRow({
      name: plan.name,
      label: plan.label,
      required: plan.required ? 'Yes' : 'No',
      multi: plan.isArray ? `Yes — join with ${arrayDelimiter}` : 'No',
      when: onlyWhen(plan, byName) || 'Always',
      allowed:
        plan.allowed.length > 0 ? plan.allowed.join(separator) : (plan.description ?? 'Free text'),
    });
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell('name').font = { bold: plan.required };
    row.getCell('name').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: headerFill(plan) },
    };
  };

  if (closed.length > 0) {
    const banner = sheet.addRow(['Columns with a dropdown — these accept ONLY the values listed']);
    banner.font = { bold: true, color: { argb: 'FF1D4ED8' } };
    closed.forEach(addRow);
  }
  if (free.length > 0) {
    sheet.addRow([]);
    const banner = sheet.addRow(['Everything else — type freely']);
    banner.font = { bold: true, color: { argb: 'FF475569' } };
    free.forEach(addRow);
  }
}

/**
 * Blank for a conditional column this row's controller values do not unlock.
 *
 * Checks the values each controller actually renders in this row, not just the pinned one.
 *
 * @param plan - The column.
 * @param selectedIn - The values a controller renders in this row: one entry
 *   for a single-value column, the split cell for an array column, none when
 *   the controller is itself blanked or absent.
 * @returns `''` when the column does not apply, else undefined to fall through.
 */
function conditionalCell(
  plan: ColumnPlan,
  selectedIn: (field: string) => readonly string[],
): string | undefined {
  if (plan.showIfNeverApplies) return '';
  if (plan.showIf.length === 0) return undefined;
  // AND across clauses; an array controller matches when any selected value is
  // allowed. Same as `isFieldVisible`.
  const applies = plan.showIf.every(({ field, values }) => {
    const selected = selectedIn(field);
    if (selected.length === 0) return false;
    return selected.some((value) => values.length === 0 || values.includes(value));
  });
  return applies ? undefined : '';
}

/**
 * Per-row name, phone and email, so sample rows are distinct.
 *
 * Config names these columns (`ResolvedDomain.identity`). Columns with their
 * own `format` or `pattern` are left to `exampleValue`. The name sample uses
 * the column's label, since `identity.name` may not be a person.
 *
 * @param plan - The column.
 * @param rowIndex - Zero-based sample row index.
 * @param identity - The domain's identity selectors, when configured.
 * @returns The cell value, or undefined when this is not an identity column.
 */
function identityCell(
  plan: ColumnPlan,
  rowIndex: number,
  identity?: XlsxTemplateOptions['identity'],
): string | undefined {
  if (identity === undefined) return undefined;
  // Shared with `csv-template` so both formats agree.
  return identityExample(plan.name, plan.prop, identity, rowIndex);
}

/**
 * Next value of a closed set, rotated by row, so each value appears somewhere.
 *
 * Skips controllers (pinned per row) and array columns (`exampleValue` shows a
 * joined cell instead).
 *
 * @param plan - The column.
 * @param rowIndex - Zero-based sample row index.
 * @param controllers - Columns that other columns are conditional on.
 * @returns The rotated value, or undefined when rotation does not apply.
 */
function rotatedCell(
  plan: ColumnPlan,
  rowIndex: number,
  controllers: ReadonlyMap<string, string[]>,
): string | undefined {
  if (plan.allowed.length <= 1 || plan.isArray || controllers.has(plan.name)) return undefined;
  return plan.allowed[rowIndex % plan.allowed.length];
}

/**
 * Generates sample rows that demonstrate every conditional branch.
 *
 * One row per controller value: the controller is pinned, the fields it unlocks
 * are filled, and the rest are blank. Other closed sets rotate across rows.
 *
 * @param plans - Column plans.
 * @param arrayDelimiter - Delimiter for array cells.
 * @param identity - Identity selectors, for realistic phone/email cells.
 * @returns Rows as arrays positionally aligned to `plans`.
 */
function sampleRows(
  plans: readonly ColumnPlan[],
  arrayDelimiter: string,
  identity?: XlsxTemplateOptions['identity'],
): string[][] {
  const controllers = collectControllers(plans);
  const byName = new Map(plans.map((plan) => [plan.name, plan] as const));

  /**
   * Every cell of one row, each conditional resolved against its controller's
   * cell in this row. A blanked controller unlocks nothing downstream.
   */
  const rowCells = (pins: ReadonlyMap<string, string>, rowIndex: number): Map<string, string> => {
    const resolved = new Map<string, string>();
    const resolving = new Set<string>();

    /** The controller's rendered cell, split into the values it selects. */
    function selectedIn(field: string): readonly string[] {
      const controller = byName.get(field);
      if (controller === undefined) return [];
      const value = resolve(controller);
      if (value === '') return [];
      return controller.isArray ? value.split(arrayDelimiter).map((v) => v.trim()) : [value];
    }

    function resolve(plan: ColumnPlan): string {
      const done = resolved.get(plan.name);
      if (done !== undefined) return done;
      // Guards against a cyclic `x-show-if`; mid-resolution reads as blank.
      if (resolving.has(plan.name)) return '';
      resolving.add(plan.name);
      const value =
        pins.get(plan.name) ??
        // Well-known columns have no JSON Schema for `exampleValue` to use.
        wellKnownExample(plan.name) ??
        conditionalCell(plan, selectedIn) ??
        identityCell(plan, rowIndex, identity) ??
        rotatedCell(plan, rowIndex, controllers) ??
        exampleValue(plan.name, plan.prop, arrayDelimiter);
      resolving.delete(plan.name);
      resolved.set(plan.name, value);
      return value;
    }

    for (const plan of plans) resolve(plan);
    return resolved;
  };

  // Ignore identity columns in the signature; they always differ by row.
  const identityColumns = new Set(
    identity === undefined ? [] : [identity.name, identity.phone, identity.email],
  );
  const signature = (pins: ReadonlyMap<string, string>): string => {
    const cells = rowCells(pins, 0);
    return plans
      .filter((plan) => !identityColumns.has(plan.name))
      .map((plan) => cells.get(plan.name) ?? '')
      .join('');
  };

  const distinct = dedupeBy(buildPinSets(controllers), signature).slice(0, MAX_SAMPLE_ROWS);
  return distinct.map((pins, i) => {
    const cells = rowCells(pins, i);
    return plans.map((plan) => cells.get(plan.name) ?? '');
  });
}

/**
 * Maps each controller field to its allowed values.
 *
 * A controller is a closed-set column that other columns reference in `x-show-if`.
 *
 * @param plans - Column plans.
 * @returns Controller field name to its allowed values.
 */
function collectControllers(plans: readonly ColumnPlan[]): ReadonlyMap<string, string[]> {
  const controllers = new Map<string, string[]>();
  for (const plan of plans) {
    for (const { field } of plan.showIf) {
      if (controllers.has(field)) continue;
      const controller = plans.find((p) => p.name === field);
      if (controller && controller.allowed.length > 0) {
        controllers.set(field, controller.allowed);
      }
    }
  }
  return controllers;
}

/**
 * One pin set per controller value; each fixes one controller to one value.
 *
 * Ordered breadth-first (every controller's first value, then second, ...) so
 * every controller is shown within the row cap. Uncapped here; the caller
 * applies {@link MAX_SAMPLE_ROWS} after deduping.
 *
 * @param controllers - Controller fields and their allowed values.
 * @returns Pin sets, one controller value each, breadth-first across
 *   controllers.
 */
function buildPinSets(
  controllers: ReadonlyMap<string, string[]>,
): Array<ReadonlyMap<string, string>> {
  const entries = [...controllers];
  const widest = Math.max(0, ...entries.map(([, values]) => values.length));
  const pinSets: Array<ReadonlyMap<string, string>> = [];
  for (let i = 0; i < widest; i += 1) {
    for (const [field, values] of entries) {
      const value = values[i];
      if (value !== undefined) pinSets.push(new Map([[field, value]]));
    }
  }
  // A schema with no conditionals still deserves worked examples.
  return pinSets.length > 0 ? pinSets : [new Map(), new Map()];
}

/**
 * Drops entries whose key repeats one already seen, keeping the first.
 *
 * Different pin sets can render the same row; this drops the repeats.
 *
 * @param items - Items in the order they should be kept.
 * @param key - Derives the comparison key for an item.
 * @returns The items with later duplicates removed.
 */
function dedupeBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Writes tab 3: the worked examples, with the same header as the grid so a row
 * can be copied straight across.
 *
 * @param wb - Target workbook.
 * @param plans - Column plans.
 * @param arrayDelimiter - Delimiter for array cells.
 * @param identity - Identity selectors.
 */
function writeSampleSheet(
  wb: ExcelJS.Workbook,
  plans: readonly ColumnPlan[],
  arrayDelimiter: string,
  identity?: XlsxTemplateOptions['identity'],
): void {
  const sheet = wb.addWorksheet(SAMPLE_SHEET, {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }],
  });
  sheet.properties.tabColor = { argb: TAB_COLOURS.sample };
  applyColumns(sheet, plans);
  styleHeader(sheet, plans);

  for (const row of sampleRows(plans, arrayDelimiter, identity)) {
    sheet.addRow(row).font = { color: { argb: 'FF475569' }, italic: true };
  }
}

/**
 * Writes tab 4: the empty grid, with the dropdowns.
 *
 * Only the header row sits above the data, since the exported CSV's first line
 * must be the header the parser matches.
 *
 * @param wb - Target workbook.
 * @param name - Sheet name.
 * @param plans - Column plans.
 * @param byName - Columns by field name.
 * @param ranges - Range formula per closed-set column.
 * @param arrayDelimiter - Delimiter for array cells.
 */
function writeGridSheet(
  wb: ExcelJS.Workbook,
  name: string,
  plans: readonly ColumnPlan[],
  byName: ReadonlyMap<string, ColumnPlan>,
  ranges: ReadonlyMap<string, string>,
  arrayDelimiter: string,
): void {
  const sheet = wb.addWorksheet(name, { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });
  sheet.properties.tabColor = { argb: TAB_COLOURS.grid };
  applyColumns(sheet, plans);
  styleHeader(sheet, plans, { byName, arrayDelimiter });

  plans.forEach((plan, i) => {
    const range = ranges.get(plan.name);
    if (range === undefined) return;
    // No dropdown on array columns: a single-value list would reject joined values.
    if (plan.isArray) return;

    // Validate the range, not each cell: per-cell validation creates empty rows
    // that some apps export as blank lines.
    const letter = columnLetter(i + 1);
    rangeValidations(sheet).add(`${letter}2:${letter}${VALIDATED_ROWS}`, {
      type: 'list',
      allowBlank: !plan.required,
      formulae: [range],
      showErrorMessage: true,
      errorStyle: 'error',
      errorTitle: `Pick a listed value for ${plan.label}`,
      error: `"${plan.label}" only accepts the values in the dropdown. Click the arrow in this cell, or see "${VALUES_SHEET}".`,
    });
  });
}

/**
 * Range-addressable view of a sheet's data validations.
 *
 * exceljs has `worksheet.dataValidations` at runtime but not in its typings,
 * hence the cast. The workbook test checks the emitted ranges.
 *
 * @param sheet - Sheet to add range validations to.
 * @returns The sheet's validation collection.
 */
function rangeValidations(sheet: ExcelJS.Worksheet): {
  add: (address: string, validation: ExcelJS.DataValidation) => void;
} {
  return (
    sheet as unknown as {
      dataValidations: { add: (address: string, validation: ExcelJS.DataValidation) => void };
    }
  ).dataValidations;
}

/**
 * Number format for a column, so Excel does not rewrite what the operator types.
 *
 * Save As CSV writes the displayed value, so the General format can change dates,
 * drop leading zeros, or use scientific notation. Text (`@`) is the default;
 * date columns use an ISO `yyyy-mm-dd` mask.
 *
 * @param plan - The column.
 * @returns The Excel number-format code for the column's cells.
 */
function numFmtFor(plan: ColumnPlan): string {
  return plan.prop['format'] === 'date' ? 'yyyy-mm-dd' : '@';
}

/**
 * Lays out one column per planned field, in the CSV template's order.
 *
 * Width comes from the human label.
 *
 * @param sheet - Sheet to lay out.
 * @param plans - Column plans.
 */
function applyColumns(sheet: ExcelJS.Worksheet, plans: readonly ColumnPlan[]): void {
  sheet.columns = plans.map((plan) => ({
    header: plan.name,
    key: plan.name,
    width: Math.min(32, Math.max(16, plan.label.length + 2)),
    style: { numFmt: numFmtFor(plan) },
  }));
}

/** Header fill for a column, per the legend on tab 1. */
function headerFill(plan: ColumnPlan): string {
  if (plan.required) return FILL_REQUIRED;
  return isConditional(plan) ? FILL_CONDITIONAL : FILL_OPTIONAL;
}

/**
 * Applies the shared header styling, and per-column notes on the grid.
 *
 * @param sheet - Sheet whose row 1 is the header.
 * @param plans - Column plans.
 * @param notes - When given, attach a hover note to each header cell.
 */
function styleHeader(
  sheet: ExcelJS.Worksheet,
  plans: readonly ColumnPlan[],
  notes?: { byName: ReadonlyMap<string, ColumnPlan>; arrayDelimiter: string },
): void {
  const header = sheet.getRow(1);
  header.font = { bold: true, size: 11 };
  header.height = 30;
  header.alignment = { vertical: 'middle', wrapText: true };

  plans.forEach((plan, i) => {
    const cell = header.getCell(i + 1);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerFill(plan) } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } } };
    if (notes) cell.note = headerNote(plan, notes.byName, notes.arrayDelimiter);
  });
}

/**
 * Builds the header cell note: label, whether required, when it applies, and what it accepts.
 *
 * @param plan - The column.
 * @param byName - Columns by field name, for the controller's label.
 * @param arrayDelimiter - Delimiter for array cells.
 * @returns Note text.
 */
function headerNote(
  plan: ColumnPlan,
  byName: ReadonlyMap<string, ColumnPlan>,
  arrayDelimiter: string,
): string {
  const lines = [`${plan.label}${plan.required ? ' — must be filled in' : ' — optional'}`];
  if (plan.description !== undefined) lines.push(plan.description);
  const when = onlyWhen(plan, byName);
  if (when) lines.push(`${when}. Otherwise leave blank.`);

  // One sentence about multiplicity.
  const pick = plan.isArray ? 'Pick one or more of' : 'Pick one of';
  const joinHint = plan.isArray ? ` — join them with "${arrayDelimiter}".` : '';
  // Array columns have no dropdown, so do not mention one.
  const manyValues = plan.isArray
    ? `${plan.allowed.length} values to choose from — see "${VALUES_SHEET}". More than one is allowed — join them with "${arrayDelimiter}".`
    : `${plan.allowed.length} values to choose from — use the dropdown, or see "${VALUES_SHEET}".`;
  if (plan.allowed.length > 0) {
    lines.push(
      plan.allowed.length <= 10 ? `${pick}: ${plan.allowed.join(', ')}${joinHint}` : manyValues,
    );
  } else if (plan.isArray) {
    lines.push(`More than one value allowed — join them with "${arrayDelimiter}".`);
  }
  return lines.join('\n');
}

/** 1-based column index to its spreadsheet letter (1 becomes A, 27 becomes AA). */
export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCodePoint(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
