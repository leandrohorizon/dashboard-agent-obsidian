export const FEATURE_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface FeatureInfo {
  value: string | null;
  invalid: boolean;
}

export function featureItems(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  const source = Array.isArray(raw) ? raw : [raw];
  return source.map((entry) => String(entry).trim()).filter((entry) => entry !== '');
}

export function normalizeFeature(raw: unknown): FeatureInfo {
  const items = featureItems(raw);
  if (items.length === 0) return { value: null, invalid: false };
  const invalid = items.some((item) => !FEATURE_SLUG.test(item));
  return { value: items[0], invalid };
}
