export type SampleValue = { readonly ok: true; readonly value: number } | { readonly ok: false };

// D§3.2.11 and D§3.2.12: samples are newest first, so the current value is
// the first sample's first member. Its timestamp is local time with no zone
// and is ignored by design.
export function currentValue(samples: unknown): SampleValue {
  if (!Array.isArray(samples)) return { ok: false };
  const [first] = samples;
  if (!Array.isArray(first)) return { ok: false };
  const [value] = first;
  return typeof value === "number" && Number.isFinite(value) ? { ok: true, value } : { ok: false };
}
