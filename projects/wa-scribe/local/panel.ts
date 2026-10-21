export {};

type Action = "state" | "list" | "sync" | "stop" | "recover" | "open-folder" | "choose-folder";

interface Chat {
  key: string;
  accountId: string;
  chatId: string;
  name: string;
  aliases: string[];
  selected: boolean;
  result: string;
}

interface State {
  running: boolean;
  output: string;
  loggedIn: boolean;
  chats: Chat[];
  error: string | null;
  progress: string;
}

interface Reply {
  ok: boolean;
  error?: string;
  state: State;
}

interface Request {
  action: Action;
  keys?: string[];
  limit?: number;
  key?: string;
}

declare global {
  interface Window {
    waScribe?: (request: Request) => Promise<unknown>;
  }
}

const elements = {
  search: required("search", HTMLInputElement),
  refresh: required("refresh", HTMLButtonElement),
  sync: required("sync", HTMLButtonElement),
  stop: required("stop", HTMLButtonElement),
  changeFolder: required("change-folder", HTMLButtonElement),
  openFolder: required("open-folder", HTMLButtonElement),
  jobIndicator: required("job-indicator", HTMLDivElement),
  status: required("status", HTMLParagraphElement),
  error: required("error", HTMLParagraphElement),
  outputPath: required("output-path", HTMLDivElement),
  chatList: required("chat-list", HTMLUListElement),
  empty: required("empty", HTMLDivElement),
};

let currentState: State | undefined;
let hasListed = false;
let temporaryError: string | undefined;
const selectedByKey = new Map<string, boolean>();

function required<T extends HTMLElement>(id: string, kind: { new(): T }): T {
  const element = document.getElementById(id);
  if (!(element instanceof kind)) throw new Error(`Missing panel element: ${id}`);
  return element;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isChat(value: unknown): value is Chat {
  if (!isRecord(value)) return false;
  return typeof value.key === "string"
    && typeof value.accountId === "string"
    && typeof value.chatId === "string"
    && typeof value.name === "string"
    && stringArray(value.aliases)
    && typeof value.selected === "boolean"
    && typeof value.result === "string";
}

function isState(value: unknown): value is State {
  if (!isRecord(value)) return false;
  return typeof value.running === "boolean"
    && typeof value.output === "string"
    && typeof value.loggedIn === "boolean"
    && Array.isArray(value.chats)
    && value.chats.every(isChat)
    && (typeof value.error === "string" || value.error === null)
    && typeof value.progress === "string";
}

function parseReply(value: unknown): Reply {
  if (!isRecord(value) || typeof value.ok !== "boolean" || !isState(value.state)) {
    throw new Error("Invalid local app response");
  }
  if (value.error !== undefined && typeof value.error !== "string") {
    throw new Error("Invalid local app response");
  }
  return {
    ok: value.ok,
    state: value.state,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

async function request(requestValue: Request): Promise<Reply> {
  if (typeof window.waScribe !== "function") {
    throw new Error("Local app bridge is unavailable");
  }
  const result = await window.waScribe(requestValue);
  return parseReply(result);
}

function updateState(state: State): void {
  currentState = state;
  for (const chat of state.chats) {
    if (!selectedByKey.has(chat.key)) selectedByKey.set(chat.key, chat.selected);
  }
  render();
}

function render(): void {
  const state = currentState;
  if (!state) return;

  const running = state.running;
  elements.jobIndicator.textContent = running ? "Sync in progress" : state.loggedIn ? "Connected to WhatsApp" : "Waiting for WhatsApp";
  const baseStatus = state.progress || (running ? "Working…" : "Ready");
  const errorText = temporaryError ?? state.error;
  elements.error.textContent = errorText ?? "";
  elements.error.hidden = !errorText;
  elements.outputPath.textContent = state.output;

  elements.refresh.disabled = running;
  elements.sync.disabled = running || !state.loggedIn || !state.chats.some((chat) => selectedByKey.get(chat.key) === true);
  elements.stop.disabled = !running;
  elements.changeFolder.disabled = running;
  elements.openFolder.disabled = running;

  const query = elements.search.value.trim().toLocaleLowerCase();
  const matchingChats = state.chats.filter((chat) => {
    const searchable = [chat.name, ...chat.aliases].join(" ").toLocaleLowerCase();
    return searchable.includes(query);
  });
  const visibleChats = matchingChats.slice(0, 200);
  elements.status.textContent = matchingChats.length > visibleChats.length
    ? `${baseStatus} · Showing ${visibleChats.length} of ${matchingChats.length} matching chats.`
    : baseStatus;
  elements.chatList.replaceChildren();
  elements.empty.hidden = visibleChats.length !== 0;
  elements.empty.textContent = state.chats.length === 0
    ? hasListed ? "No chats found." : "No chats loaded yet. Choose Refresh chats to load them."
    : "No chats match your search.";

  for (const chat of visibleChats) {
    const row = document.createElement("li");
    row.className = "chat-row";
    const main = document.createElement("div");
    main.className = "chat-main";
    const label = document.createElement("label");
    label.className = "chat-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedByKey.get(chat.key) === true;
    checkbox.disabled = running;
    checkbox.addEventListener("change", () => {
      selectedByKey.set(chat.key, checkbox.checked);
      render();
    });
    const name = document.createElement("span");
    name.textContent = chat.name;
    label.append(checkbox, name);
    main.append(label);
    if (chat.result) {
      const result = document.createElement("div");
      result.className = "chat-result";
      result.textContent = chat.result;
      main.append(result);
    }

    const actions = document.createElement("div");
    actions.className = "chat-actions";
    if (/recover/i.test(chat.result)) {
      const recover = document.createElement("button");
      recover.type = "button";
      recover.textContent = "Recover";
      recover.disabled = running;
      recover.addEventListener("click", () => void runAction({ action: "recover", key: chat.key }));
      actions.append(recover);
    }
    const openChatFolder = document.createElement("button");
    openChatFolder.type = "button";
    openChatFolder.textContent = "Open folder";
    openChatFolder.disabled = running;
    openChatFolder.addEventListener("click", () => void runAction({ action: "open-folder", key: chat.key }));
    actions.append(openChatFolder);
    row.append(main, actions);
    elements.chatList.append(row);
  }
}

async function runAction(requestValue: Request): Promise<void> {
  temporaryError = undefined;
  try {
    const reply = await request(requestValue);
    if (!reply.ok) temporaryError = reply.error ?? "The local app could not complete that action.";
    if (requestValue.action === "list") hasListed = true;
    updateState(reply.state);
  } catch {
    temporaryError = "Could not reach the local app. Try again.";
    render();
  }
}

elements.search.addEventListener("input", render);
elements.refresh.addEventListener("click", () => void runAction({ action: "list" }));
elements.sync.addEventListener("click", () => {
  if (!currentState) return;
  const keys = currentState.chats
    .filter((chat) => selectedByKey.get(chat.key) === true)
    .map((chat) => chat.key);
  if (keys.length > 0) void runAction({ action: "sync", keys: [...keys], limit: 50 });
});
elements.stop.addEventListener("click", () => void runAction({ action: "stop" }));
elements.changeFolder.addEventListener("click", () => void runAction({ action: "choose-folder" }));
elements.openFolder.addEventListener("click", () => void runAction({ action: "open-folder" }));

let stateRequestPending = false;
async function pollState(): Promise<void> {
  if (stateRequestPending) return;
  stateRequestPending = true;
  try {
    const reply = await request({ action: "state" });
    if (!reply.ok) temporaryError = reply.error ?? "The local app could not read its status.";
    updateState(reply.state);
  } catch {
    if (!currentState) temporaryError = "Could not reach the local app. Try again.";
    render();
  } finally {
    stateRequestPending = false;
  }
}

void pollState();
window.setInterval(() => void pollState(), 2000);
