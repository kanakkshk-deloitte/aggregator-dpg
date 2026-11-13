'use client';

import Form from '@rjsf/core';
import type { FormProps } from '@rjsf/core';
import { customizeValidator } from '@rjsf/validator-ajv8';
import Ajv2020 from 'ajv/dist/2020';
import { enumOptionsIndexForValue, enumOptionsValueForIndex } from '@rjsf/utils';
import type {
  EnumOptionsType,
  RegistryWidgetsType,
  WidgetProps,
  FieldTemplateProps,
  ObjectFieldTemplateProps,
  ArrayFieldTemplateProps,
  ArrayFieldItemTemplateProps,
  TitleFieldProps,
  UiSchema,
  ValidatorType,
  RJSFSchema,
  GenericObjectType,
} from '@rjsf/utils';
import type { IChangeEvent } from '@rjsf/core';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
  type Ref,
} from 'react';
import { useTranslations } from 'next-intl';
import { X } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { MultiSelect } from '../ui/MultiSelect';
import { resolveVisibleSchema, stripShowIf } from '../../lib/show-if';
import { ConsentCheckboxWidget } from './ConsentCheckboxWidget';
import { LocationAutocompleteWidget } from './custom-widgets/LocationAutocompleteWidget';
import { MultiLocationAutocompleteWidget } from './custom-widgets/MultiLocationAutocompleteWidget';
import { ReferenceAutocompleteWidget } from './custom-widgets/ReferenceAutocompleteWidget';
import { PhoneWidget } from './custom-widgets/PhoneWidget';

function TextWidget(props: WidgetProps) {
  const {
    id,
    value,
    required,
    disabled,
    readonly,
    onBlur,
    onFocus,
    onChange,
    options,
    placeholder,
    type,
  } = props;
  const inputType = (options['inputType'] as string | undefined) ?? type ?? 'text';
  return (
    <input
      id={id}
      className="bd-input"
      type={inputType}
      value={value ?? ''}
      required={required}
      disabled={disabled || readonly}
      placeholder={placeholder}
      onChange={(e: ChangeEvent<HTMLInputElement>) =>
        onChange(e.target.value === '' ? options['emptyValue'] : e.target.value)
      }
      onBlur={(e) => onBlur(id, e.target.value)}
      onFocus={(e) => onFocus(id, e.target.value)}
    />
  );
}

function TextareaWidget(props: WidgetProps) {
  const { id, value, required, disabled, readonly, onChange, placeholder, options } = props;
  return (
    <textarea
      id={id}
      className="bd-input min-h-[80px] resize-y"
      value={value ?? ''}
      required={required}
      disabled={disabled || readonly}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === '' ? options['emptyValue'] : e.target.value)}
    />
  );
}

function SelectWidget(props: WidgetProps) {
  const { id, value, required, disabled, readonly, onChange, options, placeholder } = props;
  const t = useTranslations('form');
  const enumOptions = (options['enumOptions'] as EnumOptionsType[] | undefined) ?? [];
  // Options are addressed by index, since Radix values are strings only. This
  // keeps boolean and numeric enum values their original type, as in Signals-DPG.
  // `''` means no selection and shows the placeholder.
  // `value` is always passed so the Select stays controlled.
  const current = (enumOptionsIndexForValue(value, enumOptions, false) as string) ?? '';
  // Clear button: only for an optional, unlocked field that has a value.
  const clearable = !required && current !== '' && !disabled && !readonly;
  return (
    <div className="relative">
      <Select
        value={current}
        onValueChange={(index) =>
          onChange(enumOptionsValueForIndex(index, enumOptions, options['emptyValue']))
        }
        disabled={Boolean(disabled || readonly)}
        required={Boolean(required)}
      >
        <SelectTrigger
          id={id}
          {...(required ? { 'aria-required': true } : {})}
          // Pads the value span (the only direct <span> child) to make room for
          // the overlaid clear button. The button cannot nest in the trigger,
          // which is itself a <button>. Padding the trigger would move the chevron.
          className={clearable ? '[&>span]:pr-7' : undefined}
        >
          {/* `||`, not `??`: RJSF passes `''` when no `ui:placeholder` is set. */}
          <SelectValue placeholder={placeholder || t('select_placeholder')} />
        </SelectTrigger>
        <SelectContent>
          {enumOptions.map((opt, index) => (
            <SelectItem key={`${index}-${opt.label}`} value={String(index)}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {clearable && (
        <button
          type="button"
          // Same empty value as the text widgets, so RJSF drops the key.
          onClick={() => onChange(options['emptyValue'])}
          aria-label={t('clear_selection')}
          title={t('clear_selection')}
          // `right-8` sits just left of the chevron.
          className="absolute inset-y-0 right-8 my-auto flex h-6 w-6 items-center justify-center rounded-md text-(--bd-fg-muted) transition-colors hover:bg-(--bd-border-soft) hover:text-(--bd-fg) focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-(--bd-primary-50)"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function DateWidget(props: WidgetProps) {
  const { id, value, required, disabled, readonly, onChange } = props;
  return (
    <input
      id={id}
      className="bd-input"
      type="date"
      value={value ?? ''}
      required={required}
      disabled={disabled || readonly}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * Comma-separated text input for an `array<string>` schema.
 *
 * Keeps the raw text locally so commas and partial tokens survive editing.
 * Updates the array on each keystroke and normalises the text on blur.
 */
function CommaSeparatedArrayWidget(props: WidgetProps) {
  const { id, value, required, disabled, readonly, onChange, placeholder } = props;
  const t = useTranslations('form');
  const arrayValue = Array.isArray(value) ? (value as unknown[]).filter(Boolean) : [];
  const [text, setText] = useState<string>(arrayValue.join(', '));
  const lastSyncedRef = useRef<string>(arrayValue.join('|'));

  // Re-sync the text when the array changes from outside (e.g. a reset).
  useEffect(() => {
    const next = arrayValue.join('|');
    if (next !== lastSyncedRef.current) {
      setText(arrayValue.join(', '));
      lastSyncedRef.current = next;
    }
  }, [arrayValue]);

  return (
    <input
      id={id}
      className="bd-input"
      type="text"
      value={text}
      required={required}
      disabled={disabled || readonly}
      placeholder={placeholder ?? t('comma_separated')}
      onChange={(e: ChangeEvent<HTMLInputElement>) => {
        setText(e.target.value);
        const arr = e.target.value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        lastSyncedRef.current = arr.join('|');
        onChange(arr.length > 0 ? arr : undefined);
      }}
      onBlur={(e) => {
        const arr = e.target.value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const canonical = arr.join(', ');
        setText(canonical);
        lastSyncedRef.current = arr.join('|');
        onChange(arr.length > 0 ? arr : undefined);
      }}
    />
  );
}

function CheckboxWidget(props: WidgetProps) {
  const { id, value, required, disabled, readonly, onChange, label } = props;
  return (
    <label className="flex items-start gap-3 py-2 cursor-pointer">
      <input
        id={id}
        type="checkbox"
        className="w-[18px] h-[18px] rounded-[5px] mt-0.5 accent-(--bd-primary)"
        checked={Boolean(value)}
        required={required}
        disabled={disabled || readonly}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-[13.5px] text-ink-700 leading-relaxed">{label}</span>
    </label>
  );
}

function FieldTemplate(props: FieldTemplateProps) {
  const {
    id,
    label,
    required,
    description,
    errors,
    rawErrors,
    children,
    displayLabel,
    schema,
    uiSchema,
  } = props;
  if (uiSchema?.['ui:widget'] === 'hidden') {
    return null;
  }
  const isCheckbox = schema.type === 'boolean';
  // Array fields with a custom `ui:widget` render as one input, so treat them as leaves.
  const customWidget = uiSchema?.['ui:widget'];
  const arrayAsLeaf =
    schema.type === 'array' && typeof customWidget === 'string' && customWidget !== 'hidden';
  const isContainer = (schema.type === 'object' || schema.type === 'array') && !arrayAsLeaf;
  const hasError = Array.isArray(rawErrors) && rawErrors.length > 0;
  // Red border on any `.bd-input` inside an invalid field.
  const errorWrap = hasError ? '[&_.bd-input]:border-rose-400 [&_.bd-input]:ring-rose-100' : '';
  if (isCheckbox) {
    return (
      <div className={`form-group ${errorWrap}`}>
        {children}
        {errors}
      </div>
    );
  }
  if (isContainer) {
    return (
      <div className="form-group">
        {children}
        {errors}
      </div>
    );
  }
  return (
    <div className={`form-group ${errorWrap}`}>
      {displayLabel && label && (
        <label className="bd-label" htmlFor={id}>
          {label}
          {required && <span className="text-rose-500"> *</span>}
        </label>
      )}
      {children}
      {description}
      {errors}
    </div>
  );
}

/**
 * Reads the `uiSchema` off one of `ObjectFieldTemplate`'s child slots.
 *
 * React 19 types element `props` as `unknown`, so the shape is narrowed here.
 *
 * @param content - The rendered child field element.
 * @returns The child's `uiSchema`, or `undefined` when it carries none.
 */
function childUiSchema(content: ReactElement): Record<string, unknown> | undefined {
  return (content.props as { uiSchema?: Record<string, unknown> }).uiSchema;
}

/** One titled group of fields, from the schema's `x-form-layout`. */
interface FormLayoutSection {
  title: string;
  fields: string[];
}

/**
 * Schema-authored form layout (`x-form-layout` on the item schema).
 *
 * `sections` gives the grouping and field order; `twoColumn` names fields that
 * can sit two per row. The Signals profile form reads the same block.
 */
interface FormLayout {
  sections: FormLayoutSection[];
  twoColumn?: string[];
}

type ObjectProperty = ObjectFieldTemplateProps['properties'][number];

/**
 * Groups a section's fields into rows, pairing adjacent two-column fields.
 *
 * Every other field gets its own row, so no row is left half empty.
 *
 * @param fields - The section's visible fields, in layout order.
 * @param twoColumn - Field names the layout marks as two-column.
 * @returns Rows of one or two fields.
 */
function packRows(fields: ObjectProperty[], twoColumn: Set<string>): ObjectProperty[][] {
  const rows: ObjectProperty[][] = [];
  let i = 0;
  while (i < fields.length) {
    const current = fields[i]!;
    const next = fields[i + 1];
    if (twoColumn.has(current.name) && next && twoColumn.has(next.name)) {
      rows.push([current, next]);
      i += 2;
    } else {
      rows.push([current]);
      i += 1;
    }
  }
  return rows;
}

/**
 * Renders the form as the schema's numbered sections.
 *
 * A section with no visible fields is skipped, and numbering counts only
 * rendered sections. Fields not listed in the layout render after the sections.
 */
function SectionedObject({
  layout,
  properties,
}: Readonly<{ layout: FormLayout; properties: ObjectProperty[] }>) {
  const byName = new Map(properties.map((p) => [p.name, p]));
  const twoColumn = new Set(layout.twoColumn ?? []);
  const claimed = new Set<string>();
  let sectionNumber = 0;

  const sections = layout.sections.map((section) => {
    const fields = section.fields
      .map((name) => byName.get(name))
      .filter((p): p is ObjectProperty => Boolean(p));
    if (fields.length === 0) return null;
    fields.forEach((f) => claimed.add(f.name));
    sectionNumber += 1;
    return { title: section.title, number: sectionNumber, rows: packRows(fields, twoColumn) };
  });

  const orphans = properties.filter((p) => !claimed.has(p.name));

  return (
    <div className="space-y-8">
      {sections.map(
        (section) =>
          section && (
            <section key={section.title}>
              <div className="mb-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-(--bd-primary-50) text-[12px] font-bold text-(--bd-primary-600)">
                    {section.number}
                  </div>
                  <h3 className="font-display text-[15px] font-bold tracking-tight text-ink-900">
                    {section.title}
                  </h3>
                </div>
                <div className="mt-3 h-px bg-linear-to-r from-(--bd-border) to-transparent" />
              </div>
              <div className="space-y-3">
                {section.rows.map((row) =>
                  row.length === 2 ? (
                    <div
                      key={row[0]!.name}
                      className="grid grid-cols-1 gap-x-5 gap-y-3 md:grid-cols-2"
                    >
                      {row.map((p) => (
                        <div key={p.name}>{p.content}</div>
                      ))}
                    </div>
                  ) : (
                    <div key={row[0]!.name}>{row[0]!.content}</div>
                  ),
                )}
              </div>
            </section>
          ),
      )}
      {orphans.map((p) => (
        <div key={p.name}>{p.content}</div>
      ))}
    </div>
  );
}

function ObjectFieldTemplate(props: ObjectFieldTemplateProps) {
  const { properties, title, description, uiSchema, schema } = props;
  const layout = (uiSchema?.['ui:layout'] as 'grid' | 'stack' | undefined) ?? 'grid';
  // An empty or false `ui:title` hides the heading.
  const explicitTitle = uiSchema?.['ui:title'] as string | false | undefined;
  const showTitle = explicitTitle !== '' && explicitTitle !== false && Boolean(title);
  // Skip hidden children so they leave no empty wrapper in the grid.
  const visibleProperties = properties.filter(
    (p) => childUiSchema(p.content)?.['ui:widget'] !== 'hidden',
  );

  // `x-form-layout` (root schema only) takes precedence over the flat grid.
  const formLayout = (schema as { 'x-form-layout'?: FormLayout } | undefined)?.['x-form-layout'];
  if (formLayout?.sections?.length) {
    return <SectionedObject layout={formLayout} properties={visibleProperties} />;
  }

  return (
    <div className="space-y-3">
      {showTitle && (
        <div>
          <h3 className="font-display font-bold text-[15px] text-ink-900">{title}</h3>
          {description && <p className="text-[12.5px] text-ink-400 mt-0.5">{description}</p>}
        </div>
      )}
      <div
        className={
          layout === 'grid'
            ? 'grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-3'
            : 'flex flex-col gap-3'
        }
      >
        {visibleProperties.map((p) => {
          const span = (childUiSchema(p.content)?.['ui:colSpan'] as 1 | 2 | undefined) ?? 1;
          return (
            <div key={p.name} className={span === 2 ? 'md:col-span-2' : ''}>
              {p.content}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Reads the `itemLabel` ui option off an array field's own uiSchema.
 *
 * Used by both array templates; the item template passes `parentUiSchema`.
 *
 * @param uiSchema - The array field's uiSchema, if it declares one.
 * @returns The configured item noun, defaulting to `entry`.
 */
function arrayItemLabel(uiSchema: UiSchema | undefined): string {
  return (uiSchema?.['ui:options']?.['itemLabel'] as string | undefined) ?? 'entry';
}

/**
 * Renders one array item with an "<Item> N" heading and Remove button.
 *
 * The heading and button show only when the array has more than one entry.
 *
 * @param props - RJSF array item props.
 * @returns One array row, with its header when the array has several rows.
 */
function ArrayFieldItemTemplate(props: ArrayFieldItemTemplateProps) {
  const { children, index, totalItems, buttonsProps, parentUiSchema } = props;
  const itemLabel = arrayItemLabel(parentUiSchema);
  const multiple = totalItems > 1;
  return (
    <div className="space-y-2">
      {multiple && (
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] font-semibold text-ink-500">
            {capitalise(itemLabel)} {index + 1}
          </span>
          {buttonsProps.hasRemove && (
            <button
              type="button"
              onClick={buttonsProps.onRemoveItem}
              className="text-[12.5px] text-rose-500 hover:text-rose-600"
            >
              Remove
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

function ArrayFieldTemplate(props: ArrayFieldTemplateProps) {
  const { title, items, canAdd, onAddClick, uiSchema } = props;
  const itemLabel = arrayItemLabel(uiSchema);
  return (
    <div className="space-y-3">
      {title && <h3 className="font-display font-bold text-[15px] text-ink-900">{title}</h3>}
      {/* Items arrive already rendered and keyed. */}
      {items}
      {canAdd && (
        <button
          type="button"
          onClick={onAddClick}
          className="inline-flex items-center gap-1.5 text-[13px] text-primary-600 hover:text-primary-700 font-semibold"
        >
          + Add another {itemLabel.toLowerCase()}
        </button>
      )}
    </div>
  );
}

function capitalise(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function TitleField(_props: TitleFieldProps) {
  return null;
}

/**
 * Multi-select dropdown for array-of-enum schemas.
 *
 * Picked values show as removable chips. Writes `string[]`, or `undefined` when empty.
 */
function CheckboxesWidget(props: WidgetProps) {
  const { id, value, required, disabled, readonly, onChange, options, placeholder } = props;
  const t = useTranslations('form');
  const enumOptions =
    (options['enumOptions'] as Array<{ value: string; label: string }> | undefined) ?? [];
  const current: string[] = Array.isArray(value)
    ? (value as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
  return (
    <MultiSelect
      id={id}
      options={enumOptions}
      value={current}
      onChange={(next) => onChange(next.length > 0 ? next : undefined)}
      placeholder={placeholder ?? t('select_options')}
      disabled={Boolean(disabled || readonly)}
      required={Boolean(required)}
    />
  );
}

// Default widgets are aliased to TextWidget so `.bd-input` styling applies.
const widgets: RegistryWidgetsType = {
  TextWidget,
  // Custom widgets, keyed by the names the uiSchema uses. Same as the Signals profile form.
  'location-autocomplete': LocationAutocompleteWidget,
  'location-multi': MultiLocationAutocompleteWidget,
  'reference-autocomplete': ReferenceAutocompleteWidget,
  phone: PhoneWidget,
  TextareaWidget,
  SelectWidget,
  DateWidget,
  CheckboxWidget,
  CheckboxesWidget,
  CommaSeparatedArrayWidget,
  ConsentCheckbox: ConsentCheckboxWidget,
  // Native input type gives the right mobile keyboard and autofill.
  EmailWidget: (props: WidgetProps) => <TextWidget {...props} type="email" />,
  URLWidget: (props: WidgetProps) => <TextWidget {...props} type="url" />,
  UpDownWidget: TextWidget,
  RangeWidget: TextWidget,
  PasswordWidget: TextWidget,
  ColorWidget: TextWidget,
};

export interface RjsfThemedFormProps<T extends GenericObjectType = GenericObjectType> extends Omit<
  FormProps<T>,
  'validator' | 'widgets' | 'templates'
> {
  className?: string;
  /** The RJSF form instance, e.g. to call `validateForm()` from outside it. */
  ref?: Ref<Form<T>>;
  /**
   * Called when the validity of the visible form changes.
   *
   * `true` once every visible required field is valid. Hidden fields never block.
   */
  onValidityChange?: (valid: boolean) => void;
}

export function RjsfThemedForm<T extends GenericObjectType = GenericObjectType>({
  className,
  showErrorList = false,
  liveValidate = false,
  noHtml5Validate = true,
  // On by default so `x-show-if`-hidden values never validate or submit.
  omitExtraData = true,
  liveOmit = true,
  schema,
  formData,
  onChange,
  onValidityChange,
  ...props
}: RjsfThemedFormProps<T>) {
  // Uses Ajv's 2020 build because the schemas declare draft 2020-12.
  const validator = customizeValidator({
    AjvClass: Ajv2020 as unknown as Parameters<typeof customizeValidator>[0] extends {
      AjvClass?: infer C;
    }
      ? C
      : never,
  }) as unknown as ValidatorType<T, RJSFSchema, GenericObjectType>;

  // Apply `x-show-if`: hidden fields are removed and their values cleared.
  const currentData = (formData ?? {}) as Record<string, unknown>;
  const resolved = resolveVisibleSchema(schema as RJSFSchema, currentData);
  const hiddenKey = resolved.hidden.join('|');

  // Memoised on the schema and the visible-field set so inputs keep focus
  // while typing. `x-show-if` is stripped so Ajv never sees it.
  const renderSchema = useMemo(
    () => stripShowIf(resolveVisibleSchema(schema as RJSFSchema, currentData).schema),
    [schema, hiddenKey],
  );

  // Validity of the visible form only.
  const isValid = validator.isValid(
    renderSchema as RJSFSchema,
    resolved.formData as T,
    renderSchema as RJSFSchema,
  );
  // Ref so the effect fires only when validity changes.
  const validityCb = useRef(onValidityChange);
  validityCb.current = onValidityChange;
  useEffect(() => {
    validityCb.current?.(isValid);
  }, [isValid]);

  return (
    <div className={className}>
      <Form<T>
        showErrorList={showErrorList}
        liveValidate={liveValidate}
        noHtml5Validate={noHtml5Validate}
        omitExtraData={omitExtraData}
        liveOmit={liveOmit}
        {...props}
        schema={renderSchema as RJSFSchema}
        formData={resolved.formData as T}
        onChange={(e: IChangeEvent<T>, id?: string) => {
          // Clear newly hidden fields before passing the change up.
          const next = (e.formData ?? {}) as Record<string, unknown>;
          const cleared = resolveVisibleSchema(schema as RJSFSchema, next).formData;
          onChange?.({ ...e, formData: cleared as T }, id);
        }}
        validator={validator}
        widgets={widgets}
        templates={{
          FieldTemplate,
          ObjectFieldTemplate,
          ArrayFieldTemplate,
          ArrayFieldItemTemplate,
          TitleFieldTemplate: TitleField,
        }}
      />
    </div>
  );
}
