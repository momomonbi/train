const fs = require("node:fs"),
  vm = require("node:vm"),
  C = require("../train-core.js");
const html = fs.readFileSync(require.resolve("../index.html"), "utf8"),
  source = fs.readFileSync(require.resolve("../app.js"), "utf8");
class Element {
  constructor(id) {
    this.id = id;
    this.value = "";
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.innerHTML = "";
    this.textContent = "";
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    const classes = new Set();
    this.classList = {
      contains: (x) => classes.has(x),
      add: (x) => classes.add(x),
      remove: (x) => classes.delete(x),
      toggle: (x, on) => {
        const yes = on === undefined ? !classes.has(x) : on;
        yes ? classes.add(x) : classes.delete(x);
        return yes;
      },
    };
  }
  addEventListener(name, fn) {
    this.listeners[name] = fn;
  }
  setAttribute(k, v) {
    this.attributes[k] = v;
  }
  append(...items) {
    this.children.push(...items);
  }
  replaceChildren(...items) {
    this.children = items;
    this.innerHTML = "";
  }
  querySelectorAll() {
    return [];
  }
  focus() {}
}
function runtime({
  fetchImpl = async () =>
    new Response(JSON.stringify({ csrf: "fixture-token" })),
  storage = {},
} = {}) {
  const nodes = new Map(
    [...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], new Element(m[1])]),
  );
  for (const match of html.matchAll(
    /<select[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g,
  )) {
    const choices = [...match[2].matchAll(/<option value="([^"]+)"([^>]*)>/g)];
    nodes.get(match[1]).value =
      (choices.find((x) => x[2].includes("selected")) || choices[0])?.[1] || "";
  }
  nodes.get("timeoutSec").value = "120";
  const memory = new Map(Object.entries(storage));
  const pendingTimers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    TrainCore: C,
    document: {
      getElementById: (id) => {
        if (!nodes.has(id)) nodes.set(id, new Element(id));
        return nodes.get(id);
      },
      createElement: (tag) => new Element(tag),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: {},
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: {
      getItem: (key) => memory.get(key) || null,
      setItem: (key, value) => memory.set(key, String(value)),
      removeItem: (key) => memory.delete(key),
    },
    fetch: fetchImpl,
    Date,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    setTimeout: (fn) => {
      const id = ++timerId;
      pendingTimers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => pendingTimers.delete(id),
    setInterval: (fn) => {
      const id = ++timerId;
      pendingTimers.set(id, fn);
      return id;
    },
    clearInterval: (id) => pendingTimers.delete(id),
    prompt: () => null,
    confirm: () => true,
    alert() {},
    TRAIN_HOLIDAYS: ["2026-10-12"],
    TRAIN_HOLIDAY_YEARS: [2026],
  });
  vm.runInContext(source, context);
  return {
    nodes,
    memory,
    pendingTimers,
    run: (code) => vm.runInContext(code, context),
    flush: () => new Promise((resolve) => setImmediate(resolve)),
  };
}
module.exports = { runtime };
