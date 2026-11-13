/**
 * The additional roles a coordinator holds, as badges in the console's
 * coordinator list (#873, e.g. Data Export, PII Access).
 */

/**
 * One badge per role key, labelled with the role's name when known.
 *
 * @param props.roles - The role keys the coordinator holds.
 * @param props.names - Role names by key; a key without a name shows as-is.
 */
export function RoleBadges({
  roles,
  names,
}: Readonly<{ roles: readonly string[]; names: Readonly<Record<string, string>> }>) {
  if (roles.length === 0) return <span className="text-ink-400">—</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {roles.map((key) => (
        <span
          key={key}
          className="inline-flex items-center rounded-full bg-(--bd-primary-50) text-primary-600 px-2.5 py-0.5 text-[11.5px] font-semibold whitespace-nowrap"
        >
          {names[key] ?? key}
        </span>
      ))}
    </div>
  );
}
