import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Queue,
  AttemptedError,
  RejectedError,
  UncertainError,
} from "../src/queue";
import type { Letter } from "../src/types";

function letter(index = 0): Letter {
  return {
    companyId: `company-${index}`,
    companyName: `Компания ${index}`,
    to: [`company-${index}@example.invalid`],
    subject: "Обращение",
    body: "Текст обращения",
    missing: ["ИНН организации"],
    actions: ["Письмо не подписано"],
  };
}

test("50 automatic sends are sequential, preserve warnings, and are never repeated", async () => {
  const calls: string[] = [];
  const sending: string[] = [];
  let active = 0;
  let maximum = 0;
  const queue = new Queue(
    Array.from({ length: 50 }, (_, index) => letter(index)),
    {
      async prepare(current, _signal, progress) {
        active++;
        maximum = Math.max(maximum, active);
        progress?.("sending");
        await Promise.resolve();
        calls.push(current.companyId);
        active--;
        return "sent";
      },
    },
    () => {
      const current = queue.items.find((item) => item.status === "sending");
      if (current) sending.push(current.letter.companyId);
    },
  );
  await queue.run();
  await queue.run(true);
  assert.equal(maximum, 1);
  assert.equal(calls.length, 50);
  assert.equal(new Set(calls).size, 50);
  assert.equal(new Set(sending).size, 50);
  assert.ok(queue.items.every((item) => item.status === "sent"));
  assert.ok(queue.items.every((item) => item.letter.missing.length === 1));
  assert.ok(queue.items.every((item) => item.letter.actions.length === 1));
});

test("stopping after a confirmed send leaves later letters queued", async () => {
  let calls = 0;
  const queue = new Queue(
    [letter(0), letter(1), letter(2)],
    {
      async prepare() {
        if (++calls === 1) queue.stop();
        return "sent";
      },
    },
    () => {},
  );
  await queue.run();
  assert.deepEqual(
    queue.items.map((item) => item.status),
    ["sent", "queued", "queued"],
  );
  await queue.run();
  assert.equal(calls, 3);
  assert.ok(queue.items.every((item) => item.status === "sent"));
});

test("cancellation before a click pauses and does not retry the opened draft", async () => {
  let clicks = 0;
  let calls = 0;
  const queue = new Queue(
    [letter(0), letter(1)],
    {
      async prepare(_letter, signal) {
        if (++calls === 1) queue.stop();
        if (signal.aborted) throw new AttemptedError("Остановлено до отправки");
        clicks++;
        return "sent";
      },
    },
    () => {},
  );
  await queue.run();
  assert.equal(clicks, 0);
  assert.equal(queue.items[0].attempted, true);
  assert.equal(queue.items[1].status, "queued");
  await queue.run(true);
  assert.equal(calls, 2);
  assert.equal(clicks, 1);
  assert.equal(queue.items[0].status, "error");
  assert.equal(queue.items[1].status, "sent");
});

test("a missing send acknowledgment pauses and can never retry that letter", async () => {
  const calls: string[] = [];
  const queue = new Queue(
    [letter(0), letter(1)],
    {
      async prepare(current, _signal, progress) {
        calls.push(current.companyId);
        progress?.("sending");
        if (calls.length === 1) throw new UncertainError();
        return "sent";
      },
    },
    () => {},
  );
  await queue.run();
  assert.equal(queue.items[0].status, "uncertain");
  assert.equal(queue.items[0].attempted, true);
  assert.equal(queue.items[1].status, "queued");
  assert.match(queue.items[0].error!, /могло быть отправлено/);
  await queue.run(true);
  assert.deepEqual(calls, ["company-0", "company-1"]);
  assert.equal(queue.items[0].status, "uncertain");
});

test("a provider send failure pauses the queue with its reason and continuing skips the attempted company", async () => {
  const calls: string[] = [];
  const reason =
    "Яндекс сообщил об ошибке отправки: Не указаны получатели (код: illegal_params)";
  const queue = new Queue(
    [letter(0), letter(1)],
    {
      async prepare(current, _signal, progress) {
        calls.push(current.companyId);
        progress?.("sending");
        if (calls.length === 1) throw new RejectedError(reason);
        return "sent";
      },
    },
    () => {},
  );
  await queue.run();
  assert.deepEqual(calls, ["company-0"]);
  assert.equal(queue.running, false);
  assert.equal(queue.items[0].status, "error");
  assert.equal(queue.items[0].attempted, true);
  assert.equal(queue.items[0].rejected, true);
  assert.equal(queue.items[0].error, reason);
  assert.equal(queue.items[1].status, "queued");
  await queue.run(true);
  assert.deepEqual(calls, ["company-0", "company-1"]);
  assert.equal(queue.items[0].status, "error");
  assert.equal(queue.items[0].rejected, true);
  assert.equal(queue.items[1].status, "sent");
});

test("a failure before opening Compose can be explicitly retried", async () => {
  let calls = 0;
  const queue = new Queue(
    [letter()],
    {
      async prepare() {
        if (++calls === 1) throw new Error("Кнопка «Написать» недоступна");
        return "sent";
      },
    },
    () => {},
  );
  await queue.run();
  assert.equal(queue.items[0].attempted, false);
  await queue.run(true);
  assert.equal(calls, 2);
  assert.equal(queue.items[0].status, "sent");
});

test("draft results never acquire a sent status", async () => {
  const queue = new Queue(
    [{ ...letter(), missing: [], actions: [] }, letter(1)],
    { async prepare() {} },
    () => {},
  );
  await queue.run();
  assert.deepEqual(
    queue.items.map((item) => item.status),
    ["filled", "manual"],
  );
});

test("current-tab draft queue pauses after each letter and continues only on the next run", async () => {
  const calls: string[] = [];
  const queue = new Queue(
    [{ ...letter(0), missing: [], actions: [] }, letter(1), letter(2)],
    {
      async prepare(current) {
        calls.push(current.companyId);
      },
    },
    () => {},
    true,
  );
  await queue.run();
  assert.deepEqual(
    queue.items.map((item) => item.status),
    ["filled", "queued", "queued"],
  );
  assert.equal(queue.running, false);
  await queue.run();
  assert.deepEqual(
    queue.items.map((item) => item.status),
    ["filled", "manual", "queued"],
  );
  await queue.run();
  await queue.run(true);
  assert.deepEqual(calls, ["company-0", "company-1", "company-2"]);
  assert.deepEqual(
    queue.items.map((item) => item.status),
    ["filled", "manual", "manual"],
  );
});

test("draft pausing does not pause confirmed automatic sends", async () => {
  const queue = new Queue(
    [letter(0), letter(1)],
    {
      async prepare() {
        return "sent";
      },
    },
    () => {},
    true,
  );
  await queue.run();
  assert.deepEqual(
    queue.items.map((item) => item.status),
    ["sent", "sent"],
  );
});

for (const phase of [
  "initial",
  "opening",
  "sending",
  "sent",
  "final",
] as const) {
  test(`a failing ${phase} UI update cannot stall a queue or repeat a letter`, async () => {
    const delivered: string[] = [];
    let thrown = false;
    const queue = new Queue(
      [letter(0), letter(1)],
      {
        async prepare(current, _signal, progress) {
          progress?.("sending");
          delivered.push(current.companyId);
          return "sent";
        },
      },
      () => {
        const statuses = queue.items.map((item) => item.status);
        const matches =
          phase === "initial"
            ? statuses.every((status) => status === "queued")
            : phase === "final"
              ? !queue.running
              : statuses.includes(phase);
        if (matches && !thrown) {
          thrown = true;
          throw new Error("private renderer details");
        }
      },
    );
    await queue.run();
    assert.equal(thrown, true);
    assert.equal(queue.running, false);
    assert.deepEqual(
      queue.items.map((item) => item.status),
      ["sent", "sent"],
    );
    await queue.run(true);
    assert.deepEqual(delivered, ["company-0", "company-1"]);
  });
}

test("permanently broken status rendering still observes stop and preserves unsent queue items", async () => {
  const calls: string[] = [];
  const queue = new Queue(
    [letter(0), letter(1)],
    {
      async prepare(current, signal, progress) {
        progress?.("sending");
        calls.push(current.companyId);
        queue.stop();
        assert.equal(signal.aborted, true);
        throw new UncertainError();
      },
    },
    () => {
      throw new Error("private rendering error");
    },
  );
  await queue.run();
  assert.equal(queue.running, false);
  assert.deepEqual(
    queue.items.map((item) => item.status),
    ["uncertain", "queued"],
  );
  assert.deepEqual(calls, ["company-0"]);
  assert.equal(queue.items[0].attempted, true);
});
