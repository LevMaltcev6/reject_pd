import type { Store } from "./queue";
import type { Profile } from "./types";

export const PROFILE_KEY = "return-pd:profile-v1";
export const savedProfileFields = [
  "fio",
  "email",
  "inn",
  "phone",
  "series",
  "number",
  "issuer",
  "city",
  "issued",
] as const satisfies readonly (keyof Profile)[];
export type SavedProfileField = (typeof savedProfileFields)[number];
export type SavedProfile = Partial<Pick<Profile, SavedProfileField>>;

export function isSavedProfileField(
  key: keyof Profile,
): key is SavedProfileField {
  return (savedProfileFields as readonly string[]).includes(key);
}

export function readProfile(store: Store): SavedProfile {
  const raw = store.get<unknown>(PROFILE_KEY);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: SavedProfile = {};
  for (const key of savedProfileFields) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

/** Merge only the edited field: another open panel may have newer other fields. */
export function saveProfileField(
  store: Store,
  key: SavedProfileField,
  value: string,
) {
  const saved = readProfile(store);
  if (value) saved[key] = value;
  else delete saved[key];
  if (Object.keys(saved).length) store.set(PROFILE_KEY, saved);
  else store.delete(PROFILE_KEY);
}
