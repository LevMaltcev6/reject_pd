import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { PreparedLetter } from "../src/adapters";
import { SendUncertainError, sendLetter } from "../src/send-letter";

function fixture() {
  const dom = new JSDOM(
    "<!doctype html><head><style>.toast-hidden{display:none}</style></head><body></body>",
    { url: "https://mail.yandex.ru/" },
  );
  const w = dom.window;
  for (const key of ["document", "HTMLElement", "getComputedStyle"] as const)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === "getComputedStyle" ? w.getComputedStyle.bind(w) : w[key],
    });
  w.HTMLElement.prototype.getClientRects = function () {
    return [{ width: 100, height: 30 }] as unknown as DOMRectList;
  };
  const root = document.createElement("div");
  root.className = "composeReact";
  root.innerHTML =
    '<div contenteditable="true">Expected body</div><button>Send</button>';
  document.body.append(root);
  const body = root.querySelector<HTMLElement>("[contenteditable]")!;
  const prepared: PreparedLetter = {
    root,
    body,
    provider: "yandex",
    assertActive() {
      assert.equal(body.isConnected, true);
    },
  };
  const status = document.createElement("div");
  status.setAttribute("role", "alert");
  document.body.append(status);
  let clicks = 0;
  const button = root.querySelector("button")!;
  button.addEventListener("click", () => clicks++);
  return {
    dom,
    root,
    status,
    button,
    clicks: () => clicks,
    async send() {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 450);
      try {
        await sendLetter(prepared, abort.signal, () => {});
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

test("Yandex stacked statusline: a second toast confirms the second send while the first toast remains visible", async () => {
  const f = fixture();
  try {
    f.status.dataset.testid = "statusline_root_container";
    f.status.innerHTML =
      '<div class="qa-StatuslineRoot"><div><span>Message sent</span><a> Undo</a></div></div>';
    const stack = f.status.firstElementChild!;
    const original = stack.firstElementChild!;
    f.button.addEventListener("click", () => {
      const toast = document.createElement("div");
      toast.innerHTML = "<span>Message sent</span><a> Undo</a>";
      stack.append(toast);
      f.root.remove();
    });
    await f.send();
    assert.equal(stack.firstElementChild, original);
    assert.equal(stack.children.length, 2);
    assert.equal(f.clicks(), 1);
  } finally {
    f.dom.window.close();
  }
});

test("Yandex stacked statusline: showing a previously hidden second toast is a fresh confirmation", async () => {
  const f = fixture();
  try {
    f.status.dataset.testid = "statusline_root_container";
    f.status.innerHTML =
      '<div class="qa-StatuslineRoot"><div><span>Message sent</span><a> Undo</a></div><div hidden><span>Message sent</span><a> Undo</a></div></div>';
    const second = f.status.firstElementChild!.lastElementChild as HTMLElement;
    f.button.addEventListener("click", () => {
      second.hidden = false;
      f.root.remove();
    });
    await f.send();
    assert.equal(f.clicks(), 1);
  } finally {
    f.dom.window.close();
  }
});

test("Yandex stacked statusline: changing the first toast's Undo link is not another acknowledgement", async () => {
  const f = fixture();
  try {
    f.status.dataset.testid = "statusline_root_container";
    f.status.innerHTML =
      '<div class="qa-StatuslineRoot"><div><span>Message sent</span><a> Undo</a></div></div>';
    f.button.addEventListener("click", () => {
      f.status.querySelector("a")!.textContent = " View message";
      f.root.remove();
    });
    await assert.rejects(f.send(), SendUncertainError);
    assert.equal(f.clicks(), 1);
  } finally {
    f.dom.window.close();
  }
});

for (const lifecycle of ["hidden-sync", "class-async", "reattach"] as const) {
  test(`redisplaying an old unchanged notice through ${lifecycle} does not confirm a new send`, async () => {
    const f = fixture();
    try {
      f.status.textContent = "Message sent";
      f.button.addEventListener("click", () => {
        if (lifecycle === "hidden-sync") {
          f.status.hidden = true;
          f.status.hidden = false;
          f.root.remove();
        } else if (lifecycle === "reattach") {
          f.status.remove();
          document.body.append(f.status);
          f.root.remove();
        } else {
          f.status.classList.add("toast-hidden");
          setTimeout(() => {
            f.status.classList.remove("toast-hidden");
            f.root.remove();
          }, 30);
        }
      });
      await assert.rejects(f.send(), SendUncertainError);
      assert.equal(f.clicks(), 1);
    } finally {
      f.dom.window.close();
    }
  });
}

for (const expiry of ["hidden", "removed", "empty"] as const) {
  test(`a fresh success toast can be ${expiry} before the completed editor disappears`, async () => {
    const f = fixture();
    try {
      f.button.addEventListener("click", () => {
        f.status.textContent = "Message sent";
        setTimeout(() => {
          if (expiry === "hidden") f.status.hidden = true;
          else if (expiry === "removed") f.status.remove();
          else f.status.textContent = "";
        }, 15);
        setTimeout(() => f.root.remove(), 30);
      });
      await f.send();
      assert.equal(f.clicks(), 1);
    } finally {
      f.dom.window.close();
    }
  });
}

test("a fresh send failure invalidates an earlier success even in a separate notice", async () => {
  const f = fixture();
  try {
    f.button.addEventListener("click", () => {
      f.status.textContent = "Message sent";
      setTimeout(() => {
        const error = document.createElement("div");
        error.setAttribute("role", "alert");
        error.textContent = "Message not sent";
        document.body.append(error);
        f.root.remove();
      }, 30);
    });
    await assert.rejects(f.send(), SendUncertainError);
    assert.equal(f.clicks(), 1);
  } finally {
    f.dom.window.close();
  }
});

test("a failure arriving after editor closure but before the next poll revokes observed success", async () => {
  const f = fixture();
  try {
    f.button.addEventListener("click", () => {
      setTimeout(() => {
        f.status.textContent = "Message sent";
        f.root.remove();
      }, 10);
      setTimeout(() => {
        f.status.textContent = "Message not sent";
      }, 30);
    });
    await assert.rejects(f.send(), SendUncertainError);
    assert.equal(f.clicks(), 1);
  } finally {
    f.dom.window.close();
  }
});

test("an old toast disappearing permanently does not confirm a new send", async () => {
  const f = fixture();
  try {
    f.status.textContent = "Message sent";
    f.button.addEventListener("click", () => {
      f.status.hidden = true;
      f.root.remove();
    });
    await assert.rejects(f.send(), SendUncertainError);
    assert.equal(f.clicks(), 1);
  } finally {
    f.dom.window.close();
  }
});

test("adding a non-success toast beside an old stacked success does not confirm sending", async () => {
  const f = fixture();
  try {
    f.status.dataset.testid = "statusline_root_container";
    f.status.innerHTML =
      '<div class="qa-StatuslineRoot"><div><span>Message sent</span><a> Undo</a></div></div>';
    f.button.addEventListener("click", () => {
      const note = document.createElement("div");
      note.textContent = "Draft saved";
      f.status.firstElementChild!.append(note);
      f.root.remove();
    });
    await assert.rejects(f.send(), SendUncertainError);
    assert.equal(f.clicks(), 1);
  } finally {
    f.dom.window.close();
  }
});

test("expiry of the first old stacked toast does not make the second old toast fresh", async () => {
  const f = fixture();
  try {
    f.status.dataset.testid = "statusline_root_container";
    f.status.innerHTML =
      '<div class="qa-StatuslineRoot"><div><span>Message sent</span><a> Undo</a></div><div><span>Message sent</span><a> Undo</a></div></div>';
    f.button.addEventListener("click", () => {
      f.status.firstElementChild!.firstElementChild!.remove();
      f.root.remove();
    });
    await assert.rejects(f.send(), SendUncertainError);
    assert.equal(f.clicks(), 1);
  } finally {
    f.dom.window.close();
  }
});

test("wrapping an old acknowledgement text node in a new statusline element does not make it fresh", async () => {
  const f = fixture();
  try {
    f.status.dataset.testid = "statusline_root_container";
    f.status.innerHTML =
      '<div class="qa-StatuslineRoot"><div>Message sent</div></div>';
    const toast = f.status.firstElementChild!.firstElementChild!;
    f.button.addEventListener("click", () => {
      const wrapper = document.createElement("span");
      wrapper.append(toast.firstChild!);
      toast.append(wrapper);
      f.root.remove();
    });
    await assert.rejects(f.send(), SendUncertainError);
    assert.equal(f.clicks(), 1);
  } finally {
    f.dom.window.close();
  }
});

for (const lifecycle of ["ancestor-hide", "ancestor-reattach"] as const) {
  test(`an old toast's ${lifecycle} does not confirm sending`, async () => {
    const f = fixture();
    try {
      const container = document.createElement("div");
      document.body.append(container);
      container.append(f.status);
      f.status.textContent = "Message sent";
      f.button.addEventListener("click", () => {
        if (lifecycle === "ancestor-hide") {
          container.hidden = true;
          setTimeout(() => {
            container.hidden = false;
            f.root.remove();
          }, 30);
        } else {
          container.remove();
          document.body.append(container);
          f.root.remove();
        }
      });
      await assert.rejects(f.send(), SendUncertainError);
      assert.equal(f.clicks(), 1);
    } finally {
      f.dom.window.close();
    }
  });
}

for (const stack of [false, true]) {
  test(`adding an Undo link to an old ${stack ? "stacked" : "plain"} success is not a new acknowledgement`, async () => {
    const f = fixture();
    try {
      let toast: HTMLElement = f.status;
      if (stack) {
        f.status.dataset.testid = "statusline_root_container";
        f.status.innerHTML =
          '<div class="qa-StatuslineRoot"><div>Message sent</div></div>';
        toast = f.status.firstElementChild!.firstElementChild as HTMLElement;
      } else toast.textContent = "Message sent";
      f.button.addEventListener("click", () => {
        const link = document.createElement("a");
        link.textContent = " Undo";
        toast.append(link);
        f.root.remove();
      });
      await assert.rejects(f.send(), SendUncertainError);
      assert.equal(f.clicks(), 1);
    } finally {
      f.dom.window.close();
    }
  });
}
