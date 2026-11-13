import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { createRequire } from 'node:module';
import { buildXlsxTemplate, columnLetter } from '../index.js';
import { buildCsvTemplate, exampleValue, orderedColumns } from '../../csv-template/index.js';
import { WELL_KNOWN_COLUMNS } from '@aggregator-dpg/shared-primitives/bulk-columns';

/**
 * Mirrors the shapes the real networks use, including the three that constrain
 * the design: a closed set far past Excel's 255-character inline-list cap
 * (ka-dhwd's `itiTrade` is 170 values / 5,555 chars), an array column whose
 * cell holds several delimiter-joined values, and `x-show-if` conditionals —
 * which on the live seeker schema are 21 of 36 columns.
 */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'phone'],
  properties: {
    name: { type: 'string', title: 'Full Name', minLength: 1 },
    phone: { type: 'string', title: 'Mobile Number', pattern: '^[0-9]{10}$' },
    email: { type: 'string', title: 'Email', format: 'email' },
    age: { type: 'integer', title: 'Age', minimum: 14, maximum: 65 },
    gender: { type: 'string', title: 'Gender', enum: ['Male', 'Female', 'Other'] },
    workExperience: {
      type: 'string',
      title: 'Work Experience',
      enum: ['Fresher', 'Worked before'],
    },
    lastRole: {
      type: 'string',
      title: 'Last Role Held',
      'x-show-if': { workExperience: ['Worked before'] },
    },
    languageSpoken: {
      type: 'array',
      title: 'Languages Spoken',
      items: { enum: ['Hindi', 'English', 'Kannada'] },
    },
    // 300 values: nowhere near an inline list, so it must resolve via a range.
    itiTrade: {
      type: 'string',
      title: 'ITI Trade',
      enum: Array.from({ length: 300 }, (_, i) => `Trade ${i + 1}`),
    },
    notes: { type: 'string', title: 'Notes', description: 'Anything else worth knowing' },
  },
} as Record<string, unknown>;

const SCHEMA_PROPS = SCHEMA['properties'] as Record<string, Record<string, unknown>>;

/**
 * The shapes Excel silently rewrites when a column is left on General: an ISO
 * date it reformats per locale, a leading zero it drops, and a long numeric id
 * it flips to scientific notation. Save As CSV writes the DISPLAYED value.
 */
const DATED_SCHEMA = {
  type: 'object',
  required: ['joinedOn'],
  properties: {
    joinedOn: { type: 'string', title: 'Joined On', format: 'date' },
    pincode: { type: 'string', title: 'Pincode', pattern: '^[0-9]{6}$' },
    idNumber: { type: 'string', title: 'ID Number', pattern: '^[0-9]{16}$' },
  },
} as Record<string, unknown>;

const IDENTITY = { name: 'name', phone: 'phone', email: 'email' };

const TAB_INSTRUCTIONS = '1. Instructions';
const TAB_VALUES = '2. Allowed values';
const TAB_SAMPLE = '3. Sample data';
const TAB_GRID = '4. Enter your seekers';
/** Last row the generator attaches validation to (mirrors VALIDATED_ROWS). */
const VALIDATED_LAST_ROW = 500;

/** Builds the seeker workbook these cases assert against. */
async function build(delimiter = '|'): Promise<ExcelJS.Workbook> {
  const buffer = await buildXlsxTemplate(SCHEMA, 'seeker', {
    arrayDelimiter: delimiter,
    identity: IDENTITY,
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

/** All text in column 1 of a sheet, joined — for asserting on prose. */
function textOf(sheet: ExcelJS.Worksheet, column = 2): string {
  const lines: string[] = [];
  sheet.eachRow((row) => lines.push(String(row.getCell(column).value ?? '')));
  return lines.join('\n');
}

/** Row 1 of a sheet as strings. */
function header(sheet: ExcelJS.Worksheet, count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    String(sheet.getRow(1).getCell(i + 1).value ?? ''),
  );
}

describe('buildXlsxTemplate', () => {
  it('produces the four operator-facing tabs, in order, plus the hidden lists', async () => {
    const wb = await build();
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      TAB_INSTRUCTIONS,
      'Lists',
      TAB_VALUES,
      TAB_SAMPLE,
      TAB_GRID,
    ]);
  });

  it('names the grid tab after the participant type', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildXlsxTemplate(SCHEMA, 'provider')) as unknown as ExcelJS.Buffer);
    expect(wb.getWorksheet('4. Enter your providers')).toBeDefined();
  });

  it('keeps a grid name with an underscored, long type inside Excel 31-char cap', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      (await buildXlsxTemplate(SCHEMA, 'service_provider')) as unknown as ExcelJS.Buffer,
    );
    const grid = wb.worksheets.find((s) => s.name.startsWith('4.'))!;
    expect(grid.name.length).toBeLessThanOrEqual(31);
    expect(grid.name).toBe('4. Enter your service providers');
  });

  // ── The grid must stay exactly parser-shaped ─────────────────────────────

  it('uses the SAME columns in the same order as the CSV template', async () => {
    // The operator exports this sheet to CSV and uploads it, so a divergence
    // here produces a file the parser rejects.
    const wb = await build();
    const expected = orderedColumns(SCHEMA);
    const grid = wb.getWorksheet(TAB_GRID)!;

    expect(header(grid, expected.length)).toEqual(expected);
    expect(header(grid, expected.length).join(',')).toBe(
      buildCsvTemplate(SCHEMA, { exampleRow: false }).trimEnd(),
    );
  });

  it('puts NOTHING above the header row, so the exported CSV parses', async () => {
    // A label row or a merged section banner would leave an extra line in the
    // exported CSV and fail the upload. Row 1 is the machine names; row 2 is
    // where the operator's data starts.
    const wb = await build();
    const grid = wb.getWorksheet(TAB_GRID)!;
    expect(String(grid.getRow(1).getCell(1).value)).toBe('name');
    expect(grid.getRow(1).getCell(1).isMerged).toBe(false);

    const firstDataRow = orderedColumns(SCHEMA).map((_, i) => grid.getCell(2, i + 1).value);
    expect(firstDataRow.every((v) => v === null || v === undefined)).toBe(true);
  });

  it('materialises no empty rows, so Save As cannot emit 499 blank lines', async () => {
    // Validations are added against the RANGE. Assigning them cell by cell
    // materialised rows 2-500, leaving the sheet declaring
    // `<dimension ref="A1:AJ500">` with 499 empty `<row>` records. Whether
    // those export as blank lines is a per-application judgement, and if one
    // disagrees the operator types 2 rows, saves, and the upload reports 498
    // failures they cannot explain. Only the header row may exist.
    // Two separate loads on purpose: `getCell` MATERIALISES the row it touches,
    // so reading a validation off row 500 pushes `rowCount` to 500 and would
    // make this pass or fail on assertion order alone.
    const forRowCount = await build();
    expect(forRowCount.getWorksheet(TAB_GRID)!.rowCount).toBe(1);

    // The dropdowns must still be there, which is the other half of what the
    // range addressing buys. `dataValidations` is an untyped exceljs internal,
    // so an upgrade moving it has to fail here rather than ship a workbook
    // with no dropdowns at all.
    const forValidation = await build();
    const grid = forValidation.getWorksheet(TAB_GRID)!;
    const genderCol = orderedColumns(SCHEMA).indexOf('gender') + 1;
    expect(grid.getCell(2, genderCol).dataValidation?.type).toBe('list');
    expect(grid.getCell(VALIDATED_LAST_ROW, genderCol).dataValidation?.type).toBe('list');
  });

  it('has no autofilter on the grid — it is noise on an empty sheet', async () => {
    const wb = await build();
    expect(wb.getWorksheet(TAB_GRID)!.autoFilter).toBeFalsy();
  });

  // ── Dropdowns ────────────────────────────────────────────────────────────

  it('attaches a range-backed list validation to every single-value closed set', async () => {
    const wb = await build();
    const grid = wb.getWorksheet(TAB_GRID)!;
    const validation = grid.getCell(2, orderedColumns(SCHEMA).indexOf('gender') + 1).dataValidation;

    expect(validation?.type).toBe('list');
    // A range, never an inline list — Excel caps inline lists at 255 chars and
    // `itiTrade` is far past it, so the mechanism has to be uniform.
    expect(validation?.formulae?.[0]).toContain("'Lists'!$");
    // The error message names the column in words the operator recognises.
    expect(validation?.errorTitle).toContain('Gender');
    expect(validation?.error).toContain(TAB_VALUES);
  });

  it('backs a 300-value set with a range rather than an inline list', async () => {
    const wb = await build();
    const col = orderedColumns(SCHEMA).indexOf('itiTrade') + 1;
    const formula = wb.getWorksheet(TAB_GRID)!.getCell(2, col).dataValidation?.formulae?.[0] as
      string | undefined;

    expect(formula).toMatch(/'Lists'!\$[A-Z]+\$2:\$[A-Z]+\$301/);
    expect((formula ?? '').length).toBeLessThan(255);
  });

  it('leaves array columns without a dropdown, since one cell holds many values', async () => {
    const wb = await build();
    const col = orderedColumns(SCHEMA).indexOf('languageSpoken') + 1;
    // A single-value dropdown would reject the valid `Hindi|English`.
    expect(wb.getWorksheet(TAB_GRID)!.getCell(2, col).dataValidation).toBeUndefined();
  });

  it('hides the lists sheet so its values cannot be edited into the schema', async () => {
    const wb = await build();
    expect(wb.getWorksheet('Lists')!.state).toBe('veryHidden');
  });

  // ── Guidance an operator can act on ──────────────────────────────────────

  it('carries the human label, requiredness and conditionality in each header note', async () => {
    const wb = await build();
    const grid = wb.getWorksheet(TAB_GRID)!;
    const cols = orderedColumns(SCHEMA);
    const noteOf = (name: string): string => {
      const note = grid.getRow(1).getCell(cols.indexOf(name) + 1).note;
      return typeof note === 'string' ? note : JSON.stringify(note);
    };

    expect(noteOf('name')).toContain('Full Name');
    expect(noteOf('name')).toContain('must be filled in');
    expect(noteOf('age')).toContain('optional');
    // The conditional note names the CONTROLLER BY LABEL, not by field name —
    // "Work Experience", not "workExperience".
    expect(noteOf('lastRole')).toContain('Work Experience');
    expect(noteOf('lastRole')).toContain('Worked before');
    // One sentence about multiplicity, not a contradictory pair: an array with
    // a closed set used to say "join them with |" AND "Pick one of: …".
    expect(noteOf('languageSpoken')).toContain('Pick one or more of');
    expect(noteOf('languageSpoken')).toContain('join them with "|"');
    expect(noteOf('languageSpoken')).not.toContain('Pick one of');
    expect(noteOf('gender')).toContain('Pick one of');
    expect(noteOf('gender')).not.toContain('join them with');
    expect(noteOf('notes')).toContain('Anything else worth knowing');
    // A 300-value set points at the tab instead of listing them in a tooltip.
    expect(noteOf('itiTrade')).toContain('300 values');
    // A single-value closed set does get a dropdown, so the note may say so.
    expect(noteOf('itiTrade')).toContain('use the dropdown');
  });

  it('colour-codes the header by required / conditional / optional', async () => {
    const wb = await build();
    const grid = wb.getWorksheet(TAB_GRID)!;
    const cols = orderedColumns(SCHEMA);
    const fillOf = (name: string): string =>
      (grid.getRow(1).getCell(cols.indexOf(name) + 1).fill as ExcelJS.FillPattern).fgColor
        ?.argb as string;

    const required = fillOf('name');
    const conditional = fillOf('lastRole');
    const optional = fillOf('age');
    expect(new Set([required, conditional, optional]).size).toBe(3);
    // And the legend on tab 1 uses those same three fills, or it explains
    // nothing.
    const legend = wb.getWorksheet(TAB_INSTRUCTIONS)!;
    const swatches: string[] = [];
    legend.eachRow((row) => {
      const fill = row.getCell(1).fill as ExcelJS.FillPattern | undefined;
      const argb = fill?.fgColor?.argb;
      if (argb) swatches.push(argb);
    });
    expect(swatches).toEqual(expect.arrayContaining([required, conditional, optional]));
  });

  it('tells the operator which sheet to fill and how to save it', async () => {
    const wb = await build();
    const text = textOf(wb.getWorksheet(TAB_INSTRUCTIONS)!);

    expect(text).toContain(TAB_GRID);
    expect(text).toContain(TAB_SAMPLE);
    expect(text).toContain(TAB_VALUES);
    expect(text).toContain('CSV');
    // The two required columns are named by label, so "what must I fill" is
    // answered without reading 10 columns of headers.
    expect(text).toContain('"Full Name"');
    expect(text).toContain('"Mobile Number"');
    // Counts the conditional columns rather than leaving them to be
    // discovered. Anchored on the bullet: unanchored, "21 of the 10 columns"
    // and "11 of the 10 columns" both matched, so an off-by-one in the count
    // (or counting `plans` where it meant the conditional subset) passed.
    expect(text).toContain('• 1 of the 11 columns only appl');
  });

  it('lists closed sets first on the allowed-values tab, with labels', async () => {
    const wb = await build();
    const sheet = wb.getWorksheet(TAB_VALUES)!;
    const rows: string[][] = [];
    sheet.eachRow((row, n) => {
      if (n === 1) return;
      rows.push([1, 2, 3, 4, 5, 6].map((c) => String(row.getCell(c).value ?? '')));
    });

    const banner = rows.findIndex((r) => r[0]?.includes('dropdown'));
    const freeBanner = rows.findIndex((r) => r[0]?.includes('type freely'));
    expect(banner).toBeGreaterThanOrEqual(0);
    expect(freeBanner).toBeGreaterThan(banner);

    const byName = new Map(rows.map((r) => [r[0], r]));
    expect(byName.get('gender')?.[1]).toBe('Gender');
    expect(byName.get('gender')?.[5]).toContain('Male');
    expect(byName.get('name')?.[2]).toBe('Yes');
    expect(byName.get('age')?.[2]).toBe('No');
    expect(byName.get('languageSpoken')?.[3]).toContain('|');
    expect(byName.get('lastRole')?.[4]).toContain('Work Experience');
    expect(byName.get('age')?.[4]).toBe('Always');
    // Free-text columns fall back to their description.
    expect(byName.get('notes')?.[5]).toBe('Anything else worth knowing');
    // Every column appears exactly once, so the tab is a complete index. The
    // two banner rows are not columns, so match against the schema's own list
    // rather than counting rows.
    const cols = new Set(orderedColumns(SCHEMA));
    const listed = rows.map((r) => r[0]).filter((n): n is string => n !== undefined && cols.has(n));
    expect(listed).toHaveLength(cols.size);
    expect(new Set(listed).size).toBe(cols.size);
  });

  // ── Sample rows ──────────────────────────────────────────────────────────

  it('gives the sample sheet the same header as the grid, so rows copy across', async () => {
    const wb = await build();
    const cols = orderedColumns(SCHEMA);
    expect(header(wb.getWorksheet(TAB_SAMPLE)!, cols.length)).toEqual(cols);
  });

  it('emits a sample row per conditional branch, blanking what does not apply', async () => {
    const wb = await build();
    const sample = wb.getWorksheet(TAB_SAMPLE)!;
    const cols = orderedColumns(SCHEMA);
    const expCol = cols.indexOf('workExperience') + 1;
    const roleCol = cols.indexOf('lastRole') + 1;

    // `workExperience` has two values, so both branches are demonstrated — one
    // row cannot show that `lastRole` only applies to "Worked before".
    const rows = [2, 3].map((r) => ({
      experience: String(sample.getCell(r, expCol).value ?? ''),
      lastRole: String(sample.getCell(r, roleCol).value ?? ''),
    }));
    expect(rows.map((r) => r.experience)).toEqual(['Fresher', 'Worked before']);
    expect(rows[0]?.lastRole).toBe('');
    expect(rows[1]?.lastRole).not.toBe('');
  });

  it('rotates the other closed sets so each value is demonstrated somewhere', async () => {
    const wb = await build();
    const sample = wb.getWorksheet(TAB_SAMPLE)!;
    const genderCol = orderedColumns(SCHEMA).indexOf('gender') + 1;
    const seen = new Set<string>();
    for (let r = 2; r <= sample.rowCount; r += 1) {
      seen.add(String(sample.getCell(r, genderCol).value ?? ''));
    }
    // Two sample rows, so at least two of the three genders appear rather than
    // the first option repeating.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('joins an array column in ONE cell, the rule a CSV cannot express', async () => {
    // `planColumn` fills `allowed` from `items.enum`, so a multi-value column
    // reached `rotatedCell` and got one value per cell — and tab 3, the tab the
    // header comment says a row "can be copied straight across" from, never
    // demonstrated the delimiter at all.
    const wb = await build();
    const sample = wb.getWorksheet(TAB_SAMPLE)!;
    const col = orderedColumns(SCHEMA).indexOf('languageSpoken') + 1;

    for (let r = 2; r <= sample.rowCount; r += 1) {
      expect(String(sample.getCell(r, col).value ?? '')).toContain('|');
    }
    // And it is the CSV generator's own joined value, not a second opinion.
    expect(String(sample.getCell(2, col).value)).toBe(
      exampleValue('languageSpoken', SCHEMA_PROPS['languageSpoken']!, '|'),
    );
  });

  it('formats every grid column as text, so Save As CSV writes what was typed', async () => {
    // Left on General, Excel reinterprets the cell and Save As CSV writes the
    // DISPLAYED value: `2024-01-01` exports as `01/01/2024` (which
    // `ajv-formats` rejects), a leading zero is dropped, and a long numeric id
    // flips to scientific notation. That is the post-hoc `errors.csv` failure
    // this generator exists to remove, reintroduced by cell formatting.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      (await buildXlsxTemplate(DATED_SCHEMA, 'seeker')) as unknown as ExcelJS.Buffer,
    );
    const cols = orderedColumns(DATED_SCHEMA);
    for (const tab of [TAB_SAMPLE, '4. Enter your seekers']) {
      const sheet = wb.getWorksheet(tab)!;
      expect(sheet.getColumn(cols.indexOf('pincode') + 1).style.numFmt).toBe('@');
      expect(sheet.getColumn(cols.indexOf('idNumber') + 1).style.numFmt).toBe('@');
      // A date column keeps an explicit ISO mask instead, so a value Excel has
      // already parsed as a date still round-trips in the shape the CSV
      // template demonstrates.
      expect(sheet.getColumn(cols.indexOf('joinedOn') + 1).style.numFmt).toBe('yyyy-mm-dd');
    }
  });

  it('samples the configured identity columns realistically, not as prose', async () => {
    // ka-dhwd's phone declares no `pattern`, so the purely schema-driven
    // generator yields "Example Mobile Number" — a cell the row parser rejects,
    // in the one field the network dedups on. The column is named by config.
    const loose = {
      type: 'object',
      required: ['fullName', 'mobile'],
      properties: {
        fullName: { type: 'string', title: 'Full name' },
        mobile: { type: 'string', title: 'Mobile Number' },
        mailId: { type: 'string', title: 'Email' },
      },
    } as Record<string, unknown>;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      (await buildXlsxTemplate(loose, 'seeker', {
        identity: { name: 'fullName', phone: 'mobile', email: 'mailId' },
      })) as unknown as ExcelJS.Buffer,
    );
    const sample = wb.getWorksheet(TAB_SAMPLE)!;
    const cols = orderedColumns(loose);

    expect(String(sample.getCell(2, cols.indexOf('mobile') + 1).value)).toMatch(/^\d{10}$/);
    expect(String(sample.getCell(2, cols.indexOf('mailId') + 1).value)).toContain('@example.com');
    // `identity.name` is not necessarily a person — blue_dot points it at
    // `jobProviderName` — so the sample is built from the column's own label
    // rather than printing "Sample Person 1" into a company-name column.
    expect(String(sample.getCell(2, cols.indexOf('fullName') + 1).value)).toBe(
      'Sample Full name 1',
    );
  });

  it('never overrides an identity column that declares its own pattern', async () => {
    // The hardcoded 10-digit phone fails a `^\+91[0-9]{10}$` or `^[0-9]{12}$`
    // column, putting a value the row parser rejects in the field the network
    // dedups on — and making the workbook and the CSV template disagree about
    // the same column. The schema outranks the placeholder.
    const strict = {
      type: 'object',
      required: ['mobile'],
      properties: {
        fullName: { type: 'string', title: 'Full name' },
        mobile: { type: 'string', title: 'Mobile Number', pattern: '^\\+91[0-9]{10}$' },
        mailId: { type: 'string', title: 'Email', format: 'email' },
      },
    } as Record<string, unknown>;
    const props = strict['properties'] as Record<string, Record<string, unknown>>;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      (await buildXlsxTemplate(strict, 'seeker', {
        identity: { name: 'fullName', phone: 'mobile', email: 'mailId' },
      })) as unknown as ExcelJS.Buffer,
    );
    const sample = wb.getWorksheet(TAB_SAMPLE)!;
    const cols = orderedColumns(strict);

    const phone = String(sample.getCell(2, cols.indexOf('mobile') + 1).value);
    expect(phone).toMatch(/^\+91[0-9]{10}$/);
    expect(phone).toBe(exampleValue('mobile', props['mobile']!, '|'));
    // `format: email` IS what the identity email satisfies, so that one is
    // still filled per row rather than being thrown away with the rest.
    expect(String(sample.getCell(2, cols.indexOf('mailId') + 1).value)).toBe('person1@example.com');
  });

  it('reads a multi-key x-show-if the way the form renderer does', async () => {
    // `apps/web/src/lib/show-if.ts` ANDs across EVERY key and returns false for
    // a non-array value. Reading only the first key described a weaker
    // condition than the form enforces; treating a scalar as "no constraint"
    // said "always fill this in" about a column the form never shows.
    const multi = {
      type: 'object',
      properties: {
        workExperience: { type: 'string', title: 'Work Experience', enum: ['Fresher', 'Worked'] },
        state: { type: 'string', title: 'State', enum: ['KA', 'UP'] },
        lastRole: {
          type: 'string',
          title: 'Last Role',
          'x-show-if': { workExperience: ['Worked'], state: ['KA'] },
        },
        neverShown: { type: 'string', title: 'Never Shown', 'x-show-if': { state: 'KA' } },
      },
    } as Record<string, unknown>;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildXlsxTemplate(multi, 'seeker')) as unknown as ExcelJS.Buffer);
    const cols = orderedColumns(multi);

    const values = wb.getWorksheet(TAB_VALUES)!;
    const rowFor = (name: string): string[] => {
      let found: string[] = [];
      values.eachRow((row) => {
        if (String(row.getCell(1).value) === name) {
          found = [1, 2, 3, 4, 5, 6].map((c) => String(row.getCell(c).value ?? ''));
        }
      });
      return found;
    };
    // Both controllers are named, joined by "and" — not just the first key.
    expect(rowFor('lastRole')[4]).toContain('Work Experience');
    expect(rowFor('lastRole')[4]).toContain('State');
    expect(rowFor('lastRole')[4]).toContain(' and ');
    // A scalar `allowed` hides the field outright in the form; the workbook
    // must not tell the operator to fill it in.
    expect(rowFor('neverShown')[4]).not.toBe('Always');

    // A row pins one controller but RENDERS them all, so the two-key column is
    // filled exactly in the rows whose own cells satisfy both clauses. The row
    // pinning `workExperience = Worked` still shows `state = KA`, which is a
    // state the form does render — blanking `lastRole` there would contradict
    // the values printed beside it, and the header note on that same column.
    const sample = wb.getWorksheet(TAB_SAMPLE)!;
    const roleCol = cols.indexOf('lastRole') + 1;
    const neverCol = cols.indexOf('neverShown') + 1;
    const expCol = cols.indexOf('workExperience') + 1;
    const stateCol = cols.indexOf('state') + 1;
    let satisfyingRows = 0;
    for (let r = 2; r <= sample.rowCount; r += 1) {
      const at = (c: number): string => String(sample.getCell(r, c).value ?? '');
      const applies = at(expCol) === 'Worked' && at(stateCol) === 'KA';
      expect(at(roleCol) === '').toBe(!applies);
      if (applies) satisfyingRows += 1;
      // A scalar `allowed` hides the field outright — blank in every row.
      expect(at(neverCol)).toBe('');
    }
    expect(satisfyingRows).toBeGreaterThan(0);
  });

  // Finding on #754: `conditionalCell` read `pins`, so a row that rendered
  // `educationCategory = School` from the fall-through left the column keyed
  // off it blank, contradicting that column's own "Only when …" note.
  it('fills a conditional column when the row renders the controller value', async () => {
    const chained = {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', title: 'Full Name' },
        educationCategory: { type: 'string', title: 'Education', enum: ['School', 'Degree'] },
        schoolQualification: {
          type: 'string',
          title: 'School Qualification',
          enum: ['10th', '12th'],
          'x-show-if': { educationCategory: ['School'] },
        },
        // A second controller, so some rows pin THIS one and leave
        // `educationCategory` on its first value by fall-through — the case
        // reading `pins` alone got wrong.
        workExperience: { type: 'string', title: 'Work Experience', enum: ['Fresher', 'Worked'] },
        lastRole: {
          type: 'string',
          title: 'Last Role',
          'x-show-if': { workExperience: ['Worked'] },
        },
      },
    } as Record<string, unknown>;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildXlsxTemplate(chained, 'seeker')) as unknown as ExcelJS.Buffer);
    const cols = orderedColumns(chained);
    const sample = wb.getWorksheet(TAB_SAMPLE)!;
    const eduCol = cols.indexOf('educationCategory') + 1;
    const qualCol = cols.indexOf('schoolQualification') + 1;
    const expCol = cols.indexOf('workExperience') + 1;

    let fallThroughSchoolRows = 0;
    for (let r = 2; r <= sample.rowCount; r += 1) {
      const at = (c: number): string => String(sample.getCell(r, c).value ?? '');
      const qual = at(qualCol);
      if (at(eduCol) === 'School') {
        expect(qual).not.toBe('');
        // `workExperience = Worked` can only be the pinned controller, so this
        // row's `School` came from the fall-through, not from `pins`.
        if (at(expCol) === 'Worked') fallThroughSchoolRows += 1;
      } else {
        expect(qual).toBe('');
      }
    }
    expect(fallThroughSchoolRows).toBeGreaterThan(0);
  });

  it('does not point an array column at a dropdown it deliberately lacks', async () => {
    const many = {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', title: 'Full Name' },
        skills: {
          type: 'array',
          title: 'Skills',
          items: { enum: Array.from({ length: 12 }, (_, i) => `Skill ${i + 1}`) },
        },
      },
    } as Record<string, unknown>;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildXlsxTemplate(many, 'seeker')) as unknown as ExcelJS.Buffer);
    const grid = wb.getWorksheet(TAB_GRID)!;
    const col = orderedColumns(many).indexOf('skills') + 1;
    const raw = grid.getRow(1).getCell(col).note;
    const note = typeof raw === 'string' ? raw : JSON.stringify(raw);

    // `writeGridSheet` skips validation on an array column — a single-value
    // dropdown would reject a valid delimiter-joined cell — so a note telling
    // the operator to use one points at nothing.
    expect(grid.getCell(2, col).dataValidation).toBeUndefined();
    expect(note).not.toContain('use the dropdown');
    expect(note).toContain('12 values');
    expect(note).toContain(TAB_VALUES);
    expect(note).toContain('join them with "|"');
  });

  it('spends the sample-row budget across controllers, not on the first one', async () => {
    const wide = {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', title: 'Full Name' },
        // Wide enough to consume the whole budget alone, and a controller only
        // because `tradeCertificate` keys off it — `collectControllers` finds
        // controllers through their DEPENDENTS, so this pair has to come first
        // for `jobType` to be the later controller.
        trade: {
          type: 'string',
          title: 'Trade',
          enum: Array.from({ length: 20 }, (_, i) => `Trade ${i + 1}`),
        },
        tradeCertificate: {
          type: 'string',
          title: 'Trade Certificate',
          enum: ['Yes', 'No'],
          'x-show-if': { trade: ['Trade 2'] },
        },
        jobType: { type: 'string', title: 'Job Type', enum: ['Internship', 'Full-time'] },
        stipendMin: {
          type: 'string',
          title: 'Stipend Min',
          'x-show-if': { jobType: ['Full-time'] },
        },
      },
    } as Record<string, unknown>;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildXlsxTemplate(wide, 'seeker')) as unknown as ExcelJS.Buffer);
    const cols = orderedColumns(wide);
    const sample = wb.getWorksheet(TAB_SAMPLE)!;
    const stipendCol = cols.indexOf('stipendMin') + 1;

    // `jobType` is the LAST controller and its second value is what unlocks
    // `stipendMin`, so a depth-first budget never reached it and the column was
    // blank in every row — the case the module header names as the motivation.
    let demonstrated = 0;
    for (let r = 2; r <= sample.rowCount; r += 1) {
      if (String(sample.getCell(r, stipendCol).value ?? '') !== '') demonstrated += 1;
    }
    expect(demonstrated).toBeGreaterThan(0);
    // Still bounded: a sheet nobody scrolls to the end of teaches nothing.
    expect(sample.rowCount).toBeLessThanOrEqual(15);
  });

  it('honours a non-pipe delimiter from the network config', async () => {
    const wb = await build(';');
    const sheet = wb.getWorksheet(TAB_VALUES)!;
    let multi = '';
    sheet.eachRow((row) => {
      if (String(row.getCell(1).value) === 'languageSpoken') multi = String(row.getCell(4).value);
    });
    expect(multi).toContain(';');
  });

  // ── Robustness ───────────────────────────────────────────────────────────

  it('opens on the grid, so "Save As CSV" exports the right sheet', async () => {
    // Save As exports the ACTIVE sheet. Opening on Instructions would hand an
    // operator who saves straight away a CSV of the instructions, which fails
    // the upload on a header mismatch.
    const wb = await build();
    const gridIndex = wb.worksheets.findIndex((s) => s.name === TAB_GRID);
    expect(wb.views[0]?.activeTab).toBe(gridIndex);
  });

  it('leaves every sheet unprotected', async () => {
    // No sheet protection anywhere. An operator who wants to widen a column,
    // annotate the guidance or delete the sample rows they have already read
    // should be able to, and a protected sheet also blocks paste unless every
    // data cell is individually unlocked — a paste that silently fails is
    // worse than an edited header.
    const wb = await build();
    for (const sheet of wb.worksheets) {
      expect((sheet as unknown as { sheetProtection?: unknown }).sheetProtection).toBeUndefined();
    }
  });

  it('handles a schema with no properties without throwing', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      (await buildXlsxTemplate(
        { type: 'object' } as Record<string, unknown>,
        'seeker',
      )) as unknown as ExcelJS.Buffer,
    );
    expect(wb.getWorksheet(TAB_GRID)).toBeDefined();
    expect(wb.getWorksheet(TAB_INSTRUCTIONS)).toBeDefined();
  });
});

/**
 * The gap that justified deleting the shipped `bulk-samples/*.csv`: nothing
 * checked that a generated example is a row the parser would accept. Against
 * live ka-dhwd those files carried 24 columns to the schema's 36, and 18 of 20
 * seeker rows failed on stale enum values — discovered by an operator, after
 * the upload.
 *
 * These cases close it for both formats at once, by putting each generated row
 * through the pipeline `apps/worker/src/jobs/bulk-row-process.ts` runs before
 * Ajv: split delimiter-joined array cells, strip empty cells, validate, then
 * drop `required` errors (a required-field gap is not a row failure — signals
 * accepts partial `item_state` and classifies the item as `draft`; every other
 * keyword is blocking).
 */
/**
 * Drops the well-known columns before validating. They are deliberately not
 * schema properties, and `bulk-row-process` extracts them before Ajv runs —
 * validating them here would assert the opposite of what production does.
 */
function withoutWellKnown(row: Record<string, string>): Record<string, string> {
  const out = { ...row };
  for (const name of WELL_KNOWN_COLUMNS) delete out[name];
  return out;
}

describe('generated examples validate against the schema they came from', () => {
  /** The subset of an Ajv validator these cases read. */
  interface Validator {
    (data: unknown): boolean;
    errors?: Array<{
      keyword?: string;
      instancePath?: string;
      schemaPath?: string;
      message?: string;
    }> | null;
  }

  /**
   * Compiles a schema exactly as `packages/schema-loader/src/ajv.ts` does.
   *
   * Same options and the same `ajv-formats` registration, via the same
   * `createRequire` interop — both packages ship CommonJS. Anything looser here
   * would make this suite pass on rows the loader's own validator rejects.
   *
   * @param schema - The participant schema to compile.
   * @returns A validator over that schema.
   */
  function compile(schema: Record<string, unknown>): Validator {
    const require = createRequire(import.meta.url);
    const AjvCtor = require('ajv/dist/2020').default ?? require('ajv/dist/2020');
    const addFormats = require('ajv-formats').default ?? require('ajv-formats');
    const ajv = new AjvCtor({ allErrors: true, strict: false, coerceTypes: 'array' });
    addFormats(ajv);
    return ajv.compile(schema) as Validator;
  }

  /** Mirrors `preprocessArrayCells` + `stripAllEmptyCells` in the worker. */
  function toPayload(
    schema: Record<string, unknown>,
    row: Record<string, string>,
    delimiter: string,
  ): Record<string, unknown> {
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    const payload: Record<string, unknown> = {};
    for (const [field, cell] of Object.entries(row)) {
      if (props[field]?.['type'] === 'array') {
        const parts = cell
          .split(delimiter)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (parts.length > 0) payload[field] = parts;
        continue;
      }
      if (cell.trim() !== '') payload[field] = cell;
    }
    return payload;
  }

  /** Blocking reasons only — mirrors the worker's `blockingValidationReasons`. */
  function blockingErrors(
    schema: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): string[] {
    const validate = compile(schema);
    if (validate(payload)) return [];
    return (validate.errors ?? [])
      .filter((e) => e.keyword !== 'required')
      .map((e) => `${e.instancePath || e.schemaPath}: ${e.message ?? 'invalid'}`);
  }

  /**
   * Every shape a live participant schema uses that can make a GENERATED value
   * wrong: bounded patterns, a leading character class, a prefixed pattern, a
   * format, a bounded array and a bounded string.
   */
  const LIVE_SHAPED = {
    type: 'object',
    additionalProperties: false,
    required: ['fullName', 'mobile'],
    properties: {
      fullName: { type: 'string', title: 'Full Name', minLength: 1, maxLength: 60 },
      mobile: { type: 'string', title: 'Mobile Number', pattern: '^[6-9][0-9]{9}$' },
      altMobile: { type: 'string', title: 'Alternate Mobile', pattern: '^\\+91[0-9]{10}$' },
      aadhaar: { type: 'string', title: 'Aadhaar', pattern: '^[0-9]{12}$' },
      pincode: { type: 'string', title: 'Pincode', pattern: '^[0-9]{6,10}$' },
      pan: { type: 'string', title: 'PAN', pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$' },
      mailId: { type: 'string', title: 'Email', format: 'email' },
      joinedOn: { type: 'string', title: 'Joined On', format: 'date' },
      age: { type: 'integer', title: 'Age', minimum: 14, maximum: 65 },
      gender: { type: 'string', title: 'Gender', enum: ['Male', 'Female', 'Other'] },
      workExperience: {
        type: 'string',
        title: 'Work Experience',
        enum: ['Fresher', 'Worked before'],
      },
      lastRole: {
        type: 'string',
        title: 'Last Role Held',
        maxLength: 40,
        'x-show-if': { workExperience: ['Worked before'] },
      },
      languageSpoken: {
        type: 'array',
        title: 'Languages Spoken',
        maxItems: 2,
        items: { enum: ['Hindi', 'English', 'Kannada'] },
      },
    },
  } as Record<string, unknown>;

  for (const [label, schema] of [
    ['the test fixture', SCHEMA],
    ['a live-shaped schema', LIVE_SHAPED],
    ['the Excel-hostile shapes', DATED_SCHEMA],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`accepts every workbook sample row — ${label}`, async () => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(
        (await buildXlsxTemplate(schema, 'seeker', {
          identity: { name: 'fullName', phone: 'mobile', email: 'mailId' },
        })) as unknown as ExcelJS.Buffer,
      );
      const sheet = wb.getWorksheet(TAB_SAMPLE)!;
      const cols = orderedColumns(schema);
      expect(sheet.rowCount).toBeGreaterThan(1);

      for (let r = 2; r <= sheet.rowCount; r += 1) {
        const row = Object.fromEntries(
          cols.map((name, i) => [name, String(sheet.getCell(r, i + 1).value ?? '')]),
        );
        expect(blockingErrors(schema, toPayload(schema, withoutWellKnown(row), '|'))).toEqual([]);
      }
    });

    it(`accepts the CSV example row — ${label}`, () => {
      const cols = orderedColumns(schema);
      const [, example = ''] = buildCsvTemplate(schema).split('\n');
      // The generator only quotes a cell containing `,`, `"` or a newline, and
      // no example value here does, so a plain split matches the columns.
      const row = Object.fromEntries(cols.map((name, i) => [name, example.split(',')[i] ?? '']));
      expect(blockingErrors(schema, toPayload(schema, withoutWellKnown(row), '|'))).toEqual([]);
    });
  }

  it('leaves a cell blank rather than seeding a value that fails its pattern', () => {
    // `Example <Title>` in a pattern-constrained column is worse than nothing:
    // `bulk-row-process` treats a pattern miss as a blocking row error, so the
    // template would guarantee the very failure it exists to prevent.
    const unsynthesisable = { type: 'string', title: 'GST', pattern: '^[0-9]{2}[A-Z]{5}[0-9]{4}$' };
    expect(exampleValue('gst', unsynthesisable, '|')).toBe('');
  });
});

describe('columnLetter', () => {
  it('maps 1-based indexes onto spreadsheet letters past Z', () => {
    // ka-dhwd's provider schema is 40 columns wide, so AA+ is reached in
    // practice and an off-by-one here would point a dropdown at the wrong list.
    expect(columnLetter(1)).toBe('A');
    expect(columnLetter(26)).toBe('Z');
    expect(columnLetter(27)).toBe('AA');
    expect(columnLetter(40)).toBe('AN');
    expect(columnLetter(52)).toBe('AZ');
    expect(columnLetter(53)).toBe('BA');
  });
});
