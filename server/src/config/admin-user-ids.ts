const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseAdminUserIds(value: string | undefined, options: { required?: boolean } = {}): string[] {
  if (value === undefined) {
    if (options.required) throw new Error('MODU2_ADMIN_USER_IDS is required in production.');
    return [];
  }
  if (!value.trim()) throw new Error('MODU2_ADMIN_USER_IDS must contain at least one Supabase Auth UUID.');

  const entries = value.split(',').map(entry => entry.trim());
  if (entries.some(entry => !entry)) throw new Error('MODU2_ADMIN_USER_IDS must be a comma-separated UUID list without empty entries.');
  if (entries.some(entry => !UUID_PATTERN.test(entry))) throw new Error('MODU2_ADMIN_USER_IDS contains an invalid UUID.');

  // UUID comparisons are case-insensitive; normalize and deduplicate the configured list.
  return [...new Set(entries.map(entry => entry.toLowerCase()))];
}
