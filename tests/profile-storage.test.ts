import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROFILE_KEY,
  isSavedProfileField,
  readProfile,
  saveProfileField,
} from "../src/profile-storage";
import { cleanExpired, PREFIX, type Store } from "../src/queue";

function memoryStore(values = new Map<string, unknown>()): Store {
  return {
    get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    set: (key, value) => {
      values.set(key, structuredClone(value));
    },
    delete: (key) => {
      values.delete(key);
    },
    keys: () => [...values.keys()],
  };
}

test("saved profile restores only personal form fields, excluding date and other data", () => {
  const store = memoryStore();
  const profile = {
    fio: "Иванов Иван",
    email: "ivan@example.org",
    inn: "001234567890",
    phone: "+7 999 123-45-67",
    series: "0012",
    number: "034567",
    issuer: "Отдел МВД",
    city: "Москва",
    issued: "2020-01-31",
  };
  store.set(PROFILE_KEY, {
    ...profile,
    date: "2026-09-15",
    letter: "Private letter",
    template: "Changed template",
    account: "another@example.org",
    body: "Prepared body",
    expires: 0,
  });

  assert.deepEqual(readProfile(store), profile);
  assert.equal(isSavedProfileField("fio"), true);
  assert.equal(isSavedProfileField("issued"), true);
  assert.equal(isSavedProfileField("date"), false);
});

test("malformed profile records and non-string field values are ignored", () => {
  const store = memoryStore();
  for (const raw of [undefined, null, false, 42, "Иванов", [], ["Иванов"]]) {
    store.set(PROFILE_KEY, raw);
    assert.deepEqual(readProfile(store), {});
  }
  store.set(PROFILE_KEY, {
    fio: "Иванов",
    email: ["ivan@example.org"],
    inn: 1234567890,
    phone: null,
    series: false,
    number: { value: "123456" },
    issuer: "Отдел МВД",
    city: undefined,
    issued: new Date("2020-01-31"),
  });
  assert.deepEqual(readProfile(store), {
    fio: "Иванов",
    issuer: "Отдел МВД",
  });
});

test("saving preserves whitespace, partial editing values, and leading zeroes on reload", () => {
  const values = new Map<string, unknown>();
  const firstPage = memoryStore(values);
  saveProfileField(firstPage, "fio", "  Иванов Ив  ");
  saveProfileField(firstPage, "email", " ivan@");
  saveProfileField(firstPage, "city", "   ");
  saveProfileField(firstPage, "series", "00");

  const reloadedPage = memoryStore(values);
  assert.deepEqual(readProfile(reloadedPage), {
    fio: "  Иванов Ив  ",
    email: " ivan@",
    city: "   ",
    series: "00",
  });
});

test("editing one field merges the latest saved values from another panel", () => {
  const values = new Map<string, unknown>();
  const firstPanel = memoryStore(values);
  const secondPanel = memoryStore(values);
  saveProfileField(firstPanel, "fio", "Иванов");
  saveProfileField(firstPanel, "email", "old@example.org");
  const oldFirstPanelState = readProfile(firstPanel);

  saveProfileField(secondPanel, "email", "new@example.org");
  saveProfileField(secondPanel, "phone", "+7 999");
  saveProfileField(firstPanel, "fio", oldFirstPanelState.fio + " Иван");

  assert.deepEqual(readProfile(firstPanel), {
    fio: "Иванов Иван",
    email: "new@example.org",
    phone: "+7 999",
  });
  assert.deepEqual(readProfile(secondPanel), readProfile(firstPanel));
});

test("clearing one field keeps other saved fields and clearing the last removes the record", () => {
  const store = memoryStore();
  const jobKey = PREFIX + "live";
  store.set(jobKey, { expires: Date.now() + 1000 });
  saveProfileField(store, "fio", "Иванов Иван");
  saveProfileField(store, "email", "ivan@example.org");

  saveProfileField(store, "fio", "");
  assert.deepEqual(readProfile(store), { email: "ivan@example.org" });
  assert.ok(store.keys().includes(PROFILE_KEY));

  saveProfileField(store, "email", "");
  assert.equal(store.get(PROFILE_KEY), undefined);
  assert.ok(!store.keys().includes(PROFILE_KEY));
  assert.ok(store.keys().includes(jobKey));
});

test("saving a valid field discards malformed and unapproved stored properties", () => {
  const store = memoryStore();
  store.set(PROFILE_KEY, {
    fio: "Иванов Иван",
    email: 7,
    date: "2026-09-15",
    letter: "Private body",
    template: "Private template",
    account: "other@example.org",
  });
  saveProfileField(store, "phone", "+7 999");
  assert.deepEqual(store.get(PROFILE_KEY), {
    fio: "Иванов Иван",
    phone: "+7 999",
  });
});

test("queue expiration never expires the saved profile", () => {
  const store = memoryStore();
  const now = 10_000;
  const profile = { fio: "Иванов Иван", email: "ivan@example.org" };
  store.set(PROFILE_KEY, profile);
  store.set(PREFIX + "expired", { expires: now - 1 });
  store.set(PREFIX + "boundary", { expires: now });
  store.set(PREFIX + "live", { expires: now + 1 });

  cleanExpired(store, now);
  assert.deepEqual(store.get(PROFILE_KEY), profile);
  assert.equal(store.get(PREFIX + "expired"), undefined);
  assert.equal(store.get(PREFIX + "boundary"), undefined);
  assert.deepEqual(store.get(PREFIX + "live"), { expires: now + 1 });

  cleanExpired(store, now + 365 * 24 * 60 * 60 * 1000);
  assert.deepEqual(store.keys(), [PROFILE_KEY]);
  assert.deepEqual(readProfile(store), profile);
});
